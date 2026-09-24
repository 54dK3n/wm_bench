const DEFAULT_MAP_SIZE = 12;
const MAZE_MAP_SIZE = 32;
const MAX_RUNTIME_MAP_SIZE = 64;
const GUANGYANG_TERRAIN_DROP = 0.08;
const MAX_NAVIGATION_QUERIES_PER_RUN = 1000;
const MAX_NAVIGATION_CONTROLS_PER_RUN = 300;
const GUANGYANG_CONFIG = globalThis.CompetitionCore?.GUANGYANG_ISLAND_CONFIG;
const GUANGYANG_WORLD_UNITS_PER_METER = Number(GUANGYANG_CONFIG?.world?.unitsPerMeter) > 0
  ? Number(GUANGYANG_CONFIG.world.unitsPerMeter) : 8;
const GUANGYANG_CM_PER_WORLD_UNIT = 100 / GUANGYANG_WORLD_UNITS_PER_METER;

function worldUnitsToCm(value) {
  return Number(value) * GUANGYANG_CM_PER_WORLD_UNIT;
}

function cmToWorldUnits(value) {
  return Number(value) / GUANGYANG_CM_PER_WORLD_UNIT;
}
const GUANGYANG_CHALLENGE_CONFIGS = Array.isArray(globalThis.CompetitionCore?.GUANGYANG_CHALLENGE_CONFIGS)
  ? globalThis.CompetitionCore.GUANGYANG_CHALLENGE_CONFIGS
  : [GUANGYANG_CONFIG].filter(Boolean);
const GUANGYANG_CONFIG_BY_TASK_ID = Object.freeze(Object.fromEntries(
  GUANGYANG_CHALLENGE_CONFIGS.map(config => [config.taskId, config])
));
const PERSONAL_SCORE_RULES = globalThis.ChenlongAdminTeamScores;
if (!PERSONAL_SCORE_RULES) throw new Error("成绩汇总规则没有加载，请刷新页面重试");
const GUANGYANG_MISSION_KEY_BY_TASK_ID = Object.freeze(Object.fromEntries(
  GUANGYANG_CHALLENGE_CONFIGS.map((config, index) => [config.taskId, index === 0 ? "guangyang" : `guangyang${index + 1}`])
));
const COMPETITION_SCORE_MAXIMUM = globalThis.CompetitionCore?.COMPETITION_SCORE_MAXIMUM || 100;
const PUBLISHED_MAP_CONFIG_SCHEMA_VERSION = "chenlong.guangyang-map-config/v1";
const PUBLISHED_MAP_LAYOUT_SCHEMA_VERSION = "chenlong.guangyang-map-layout/v2";
const PUBLISHED_MAP_BINDING_SCHEMA_VERSION = "chenlong.guangyang-map-config-binding/v1";
const AI_AUTONOMY_SESSION_MODE = "ai";
const GUANGYANG_OBJECT_TASK_FALLBACK = Object.freeze({
  packageRadius: 0.28,
  objects: Object.freeze([
    Object.freeze({ id: "guangyang-target-1", role: "target", sourcePosition: Object.freeze([354, 195]), radius: 0.28 }),
    Object.freeze({ id: "guangyang-distractor-1", role: "distractor", sourcePosition: Object.freeze([412, 590]), radius: 0.28 }),
    Object.freeze({ id: "guangyang-obstacle-1", role: "obstacle", sourcePosition: Object.freeze([319, 480]), radius: 0.52 })
  ]),
  zones: Object.freeze([
    Object.freeze({ id: "guangyang-storage-zone", role: "storage", sourcePosition: Object.freeze([326, 151]), radius: 0.95 }),
    Object.freeze({ id: "guangyang-offroad-removal-zone", role: "offroad-removal", sourcePosition: Object.freeze([450, 610]), radius: 0.2 })
  ])
});
const GUANGYANG_OBJECT_ROLE_META = Object.freeze({
  target: Object.freeze({ category: "目标物", label: "红色目标物", color: "#ef4444" }),
  distractor: Object.freeze({ category: "混淆物", label: "蓝色混淆物", color: "#3b82f6" }),
  obstacle: Object.freeze({ category: "障碍物", label: "黄黑障碍物", color: "#facc15" }),
  storage: Object.freeze({ category: "存放点", label: "绿色存放点", color: "#22c55e" }),
  cleanup: Object.freeze({ category: "清理点", label: "橙色清理点", color: "#f97316" }),
  "offroad-removal": Object.freeze({ category: "道路外", label: "道路外移除区", color: "#f97316" })
});

function guangyangSourcePointToWorld(sourcePosition, config = GUANGYANG_CONFIG) {
  const source = config?.world?.sourceImage || {};
  const crop = source.crop || { x: 26, y: 24, width: 1295, height: 777 };
  const widthUnits = Number(source.widthUnits) || Number(config?.world?.width) || 40;
  const heightUnits = Number(source.heightUnits) || Number(config?.world?.depth) || 24;
  const sourceX = Number(sourcePosition?.[0]);
  const sourceY = Number(sourcePosition?.[1]);
  const cropX = Number(crop.x);
  const cropY = Number(crop.y);
  const cropWidth = Number(crop.width);
  const cropHeight = Number(crop.height);
  if (![sourceX, sourceY, cropX, cropY, cropWidth, cropHeight].every(Number.isFinite)
    || cropWidth <= 0 || cropHeight <= 0) return null;
  const x = (sourceX - cropX - cropWidth / 2) * widthUnits / cropWidth;
  const z = (sourceY - cropY - cropHeight / 2) * heightUnits / cropHeight;
  return [Math.round(x * 10000) / 10000, Math.round(z * 10000) / 10000];
}

function normalizeGuangyangObjectRole(value) {
  const key = String(value || "").trim().toLowerCase();
  const aliases = {
    target: "target",
    "目标物": "target",
    distractor: "distractor",
    "混淆物": "distractor",
    obstacle: "obstacle",
    "障碍物": "obstacle",
    storage: "storage",
    "storage-zone": "storage",
    "存放点": "storage",
    cleanup: "cleanup",
    "cleanup-zone": "cleanup",
    "清理点": "cleanup",
    offroad: "offroad-removal",
    "offroad-removal": "offroad-removal",
    "道路外": "offroad-removal",
    "道路外移除区": "offroad-removal"
  };
  return aliases[key] || null;
}

function objectTaskDestinationLabel(role) {
  if (role === "offroad-removal" || role === "offroad") return "道路边界外";
  if (role === "cleanup") return "清理点";
  return "存放点";
}

function normalizeGuangyangObjectTaskOverlay(config = GUANGYANG_CONFIG) {
  const configured = config?.objectTaskOverlay && typeof config.objectTaskOverlay === "object"
    ? config.objectTaskOverlay
    : {};
  const normalizeRecord = (source, fallback, index) => {
    const role = normalizeGuangyangObjectRole(source?.role ?? source?.category ?? source?.type) || fallback.role;
    const safeSource = source && typeof source === "object" ? source : fallback;
    const sourcePosition = Array.isArray(safeSource.sourcePosition) && safeSource.sourcePosition.length >= 2
      ? [Number(safeSource.sourcePosition[0]), Number(safeSource.sourcePosition[1])]
      : [...fallback.sourcePosition];
    const configuredPosition = Array.isArray(safeSource.position) && safeSource.position.length >= 2
      ? [Number(safeSource.position[0]), Number(safeSource.position[1])]
      : null;
    const convertedPosition = guangyangSourcePointToWorld(sourcePosition, config);
    const position = configuredPosition?.every(Number.isFinite)
      ? configuredPosition
      : convertedPosition || guangyangSourcePointToWorld(fallback.sourcePosition, config);
    const meta = GUANGYANG_OBJECT_ROLE_META[role];
    const radius = Number(safeSource.radius ?? safeSource.collisionRadius ?? fallback.radius);
    return {
      id: String(safeSource.id || `${fallback.id}-${index + 1}`),
      role,
      category: meta.category,
      label: String(safeSource.label || (index ? `${meta.label} ${index + 1}` : meta.label)),
      color: /^#[0-9a-f]{6}$/i.test(String(safeSource.color || "")) ? String(safeSource.color) : meta.color,
      sourcePosition,
      position,
      radius: Number.isFinite(radius) && radius > 0 ? radius : fallback.radius
    };
  };
  const currentTaskUsesRoadClearance = config?.task?.schemaVersion === "chenlong.task/v5";
  const fallbackZones = GUANGYANG_OBJECT_TASK_FALLBACK.zones
    .filter(item => !currentTaskUsesRoadClearance || item.role !== "offroad-removal");
  const normalizedObjects = (Array.isArray(configured.objects) ? configured.objects : [])
    .map((source, index) => {
      const role = normalizeGuangyangObjectRole(source?.role ?? source?.category ?? source?.type);
      const fallback = GUANGYANG_OBJECT_TASK_FALLBACK.objects.find(item => item.role === role);
      return role && fallback ? normalizeRecord(source, fallback, index) : null;
    }).filter(Boolean);
  const normalizedZones = (Array.isArray(configured.zones) ? configured.zones : [])
    .map((source, index) => {
      const role = normalizeGuangyangObjectRole(source?.role ?? source?.category ?? source?.type);
      const fallback = fallbackZones.find(item => item.role === role);
      return role && fallback ? normalizeRecord(source, fallback, index) : null;
    }).filter(Boolean);
  const objectRoles = new Set(normalizedObjects.map(item => item.role));
  const zoneRoles = new Set(normalizedZones.map(item => item.role));
  return {
    packageRadius: Number.isFinite(Number(configured.packageRadius)) && Number(configured.packageRadius) > 0
      ? Number(configured.packageRadius)
      : GUANGYANG_OBJECT_TASK_FALLBACK.packageRadius,
    objects: [
      ...normalizedObjects,
      ...GUANGYANG_OBJECT_TASK_FALLBACK.objects
        .filter(item => !objectRoles.has(item.role))
        .map((item, index) => normalizeRecord(item, item, index))
    ],
    zones: [
      ...normalizedZones,
      ...fallbackZones
        .filter(item => !zoneRoles.has(item.role))
        .map((item, index) => normalizeRecord(item, item, index))
    ]
  };
}

function buildGuangyangCompositeTask(config, overlay) {
  const configuredTask = config?.task?.type === "composite" ? config.task : {};
  const schemaVersion = ["chenlong.task/v2", "chenlong.task/v3", "chenlong.task/v4", "chenlong.task/v5"]
    .includes(configuredTask.schemaVersion)
    ? configuredTask.schemaVersion
    : "chenlong.task/v5";
  const objectsByRole = new Map();
  overlay.objects.forEach(item => {
    if (!objectsByRole.has(item.role)) objectsByRole.set(item.role, []);
    objectsByRole.get(item.role).push(item);
  });
  const objectById = new Map(overlay.objects.map(item => [item.id, item]));
  const zoneByRole = new Map(overlay.zones.map(item => [item.role, item]));
  const fallbackDistractorDestinationRole = schemaVersion === "chenlong.task/v4" || schemaVersion === "chenlong.task/v5"
    ? "offroad-removal"
    : "cleanup";
  const fallbackDeliveries = [
    { id: "delivery-target-storage", objectRole: "target", destinationRole: "storage" },
    {
      id: `delivery-distractor-${fallbackDistractorDestinationRole}`,
      objectRole: "distractor",
      destinationRole: fallbackDistractorDestinationRole
    }
  ].map(item => {
    const objects = objectsByRole.get(item.objectRole) || [];
    const object = objects[0];
    if (schemaVersion === "chenlong.task/v5" && item.objectRole === "distractor") {
      return {
        ...item,
        placementRule: "road-edge-clearance",
        objectRadius: object.radius,
        minimumRoadEdgeClearance: 0.2,
        requiredPackageIds: objects.map(candidate => candidate.id)
      };
    }
    const zone = zoneByRole.get(item.destinationRole);
    return {
      ...item,
      destination: [...zone.position],
      radius: zone.radius,
      requiredPackageIds: objects.map(candidate => candidate.id)
    };
  });
  const configuredDeliveries = Array.isArray(configuredTask.deliveries) && configuredTask.deliveries.length
    ? configuredTask.deliveries
    : fallbackDeliveries;
  const task = {
    ...configuredTask,
    schemaVersion,
    type: "composite",
    checkpointRadius: Number(configuredTask.checkpointRadius) || 1.05,
    goalRadius: Number(configuredTask.goalRadius) || 1.05,
    deliveryRadius: Number(configuredTask.deliveryRadius) || 0.95,
    deliveries: configuredDeliveries.map((source, index) => {
      const objectRole = normalizeGuangyangObjectRole(source.objectRole)
        || (index === 0 ? "target" : "distractor");
      const destinationRole = normalizeGuangyangObjectRole(source.destinationRole)
        || (objectRole === "target"
          ? "storage"
          : schemaVersion === "chenlong.task/v4" || schemaVersion === "chenlong.task/v5"
            ? "offroad-removal"
            : "cleanup");
      const sourceIds = Array.isArray(source.requiredPackageIds) && source.requiredPackageIds.length
        ? source.requiredPackageIds.map(String)
        : (objectsByRole.get(objectRole) || []).map(item => item.id);
      const object = objectById.get(sourceIds[0]) || (objectsByRole.get(objectRole) || [])[0];
      const zone = zoneByRole.get(destinationRole);
      if (schemaVersion === "chenlong.task/v5" && objectRole === "distractor") {
        return {
          id: String(source.id || source.deliveryId || "delivery-distractor-offroad-removal"),
          objectRole,
          destinationRole: "offroad-removal",
          placementRule: "road-edge-clearance",
          objectRadius: Number(source.objectRadius) > 0 ? Number(source.objectRadius) : object.radius,
          minimumRoadEdgeClearance: Number(source.minimumRoadEdgeClearance) > 0
            ? Number(source.minimumRoadEdgeClearance)
            : 0.2,
          requiredPackageIds: sourceIds
        };
      }
      const destination = Array.isArray(source.destination) && source.destination.length >= 2
        && source.destination.slice(0, 2).every(value => Number.isFinite(Number(value)))
        ? source.destination.slice(0, 2).map(Number)
        : [...zone.position];
      const delivery = {
        id: String(source.id || source.deliveryId
          || (objectRole === "target" ? "delivery-target-storage" : `delivery-distractor-${destinationRole}`)),
        objectRole,
        destinationRole,
        destination,
        radius: Number(source.radius) > 0 ? Number(source.radius) : zone.radius,
        requiredPackageIds: sourceIds
      };
      if (schemaVersion === "chenlong.task/v4" && objectRole === "distractor") {
        delivery.placementRule = "fixed-offroad-zone";
        delivery.objectRadius = Number(source.objectRadius) > 0 ? Number(source.objectRadius) : object.radius;
        delivery.minimumRoadEdgeClearance = Number(source.minimumRoadEdgeClearance) > 0
          ? Number(source.minimumRoadEdgeClearance)
          : 0.5;
      }
      return delivery;
    })
  };
  if (schemaVersion === "chenlong.task/v5") {
    const sourceRoads = Array.isArray(configuredTask.placementGeometry?.roads)
      ? configuredTask.placementGeometry.roads
      : config?.roads;
    task.placementGeometry = {
      roads: (sourceRoads || []).map(road => ({
        id: String(road.id),
        width: Number(road.width),
        points: (road.points || []).map(point => [Number(point[0]), Number(point[1])])
      }))
    };
  } else {
    delete task.placementGeometry;
  }
  if (schemaVersion === "chenlong.task/v3" || schemaVersion === "chenlong.task/v4" || schemaVersion === "chenlong.task/v5") {
    task.avoidanceObjectIds = Array.isArray(configuredTask.avoidanceObjectIds)
      ? configuredTask.avoidanceObjectIds.map(String)
      : overlay.objects.filter(item => item.role === "obstacle").map(item => item.id);
  } else {
    delete task.avoidanceObjectIds;
  }
  return task;
}

const GUANGYANG_OBJECT_TASK = normalizeGuangyangObjectTaskOverlay(GUANGYANG_CONFIG);
const GUANGYANG_COMPOSITE_TASK = buildGuangyangCompositeTask(GUANGYANG_CONFIG, GUANGYANG_OBJECT_TASK);
const GUANGYANG_RUNTIME_CONFIG = GUANGYANG_CONFIG?.task?.type === "composite"
  ? GUANGYANG_CONFIG
  : { ...(GUANGYANG_CONFIG || {}), task: GUANGYANG_COMPOSITE_TASK };

function guangyangConfigForTaskId(taskId) {
  return GUANGYANG_CONFIG_BY_TASK_ID[String(taskId || "")] || GUANGYANG_RUNTIME_CONFIG;
}

function guangyangMissionKeyForTaskId(taskId) {
  return GUANGYANG_MISSION_KEY_BY_TASK_ID[String(taskId || "")] || "guangyang";
}

function isGuangyangMissionKey(key) {
  return Object.values(GUANGYANG_MISSION_KEY_BY_TASK_ID).includes(key);
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
  guangyang: {
    title: "广阳岛综合任务",
    text: "完成目标物入库、把混淆物移出道路，绕开黄黑障碍，依次巡检 4 个检查点后返回停车区。",
    environment: "guangyang",
    mapSize: GUANGYANG_CONFIG?.world?.size || 42,
    start: GUANGYANG_CONFIG?.start || [-2.49, -7.67, Math.PI],
    obstacles: (GUANGYANG_CONFIG?.obstacles || []).map(obstacle => [...obstacle.position]),
    objectObstacles: GUANGYANG_OBJECT_TASK.objects
      .filter(item => item.role === "obstacle")
      .map(item => ({ ...item, x: item.position[0], z: item.position[1] })),
    objectZones: GUANGYANG_OBJECT_TASK.zones.map(item => ({ ...item })),
    packageVisual: "box",
    packageRadius: GUANGYANG_OBJECT_TASK.packageRadius,
    packages: GUANGYANG_OBJECT_TASK.objects
      .filter(item => item.role === "target" || item.role === "distractor")
      .map(item => ({
        id: item.id,
        x: item.position[0],
        z: item.position[1],
        category: item.category,
        color: item.color,
        radius: item.radius
      })),
    goal: GUANGYANG_CONFIG?.goal || [-2.49, -7.67],
    guidePath: [
      (GUANGYANG_CONFIG?.start || [-2.49, -7.67]).slice(0, 2),
      ...(GUANGYANG_CONFIG?.checkpoints || []).map(checkpoint => [...checkpoint.position]),
      [...(GUANGYANG_CONFIG?.goal || [-2.49, -7.67])]
    ],
    showGuidePath: false,
    completion: {
      ...GUANGYANG_COMPOSITE_TASK,
      checkpointSource: "competition",
      goalRadius: GUANGYANG_COMPOSITE_TASK.goalRadius,
      checkpointRadius: GUANGYANG_COMPOSITE_TASK.checkpointRadius
    },
    competition: { enabled: true, config: GUANGYANG_RUNTIME_CONFIG }
  }
};

// The map and visual language remain shared. Difficulty grows by task scale;
// each frozen task identity owns its own published configuration.
missions.guangyang.title = GUANGYANG_RUNTIME_CONFIG.displayName || "广阳岛综合任务1";
GUANGYANG_CHALLENGE_CONFIGS.forEach(config => {
  const key = guangyangMissionKeyForTaskId(config.taskId);
  if (key === "guangyang") return;
  const mission = structuredClone(missions[guangyangMissionKeyForTaskId(config?.taskId)] || missions.guangyang);
  mission.title = config?.displayName || mission.title;
  mission.title = config.displayName;
  const objects = Array.isArray(config.objectTaskOverlay?.objects) ? config.objectTaskOverlay.objects : [];
  const count = role => objects.filter(item => item.role === role).length;
  mission.text = `与任务1 共用广阳岛道路；完成 ${count("target")} 个目标物入库、清理 ${count("distractor")} 个混淆物、避开 ${count("obstacle")} 个障碍，并依次巡检 ${config.checkpoints.length} 个途径点后返回停车区。`;
  mission.competition = { enabled: true, config };
  missions[key] = mission;
});

function jsonStructuresEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonStructuresEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonStructuresEqual(left[key], right[key]));
}

function canonicalJsonForMapConfig(value, stack = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("地图配置不能包含无效数字");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== "object") throw new TypeError("地图配置包含不支持的数据");
  if (stack.has(value)) throw new TypeError("地图配置不能循环引用");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalJsonForMapConfig(item, stack)).join(",")}]`;
    }
    const entries = Object.keys(value).sort().map(key => {
      const item = value[key];
      if (item === undefined) throw new TypeError("地图配置不能包含空字段");
      return `${JSON.stringify(key)}:${canonicalJsonForMapConfig(item, stack)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function normalizePublishedMapPoint(value, label) {
  if (!Array.isArray(value) || value.length !== 2
    || !value.every(item => typeof item === "number" && Number.isFinite(item))) {
    throw new Error(`${label}坐标不兼容`);
  }
  const point = value.map(item => Object.is(item, -0) ? 0 : item);
  const width = Number(GUANGYANG_CONFIG?.world?.width);
  const depth = Number(GUANGYANG_CONFIG?.world?.depth);
  if (Number.isFinite(width) && Number.isFinite(depth)
    && (Math.abs(point[0]) > width / 2 || Math.abs(point[1]) > depth / 2)) {
    throw new Error(`${label}超出广阳岛地图范围`);
  }
  return point;
}

function expectedPublishedMapVersion(revision, digest, config = GUANGYANG_CONFIG) {
  return revision === 0
    ? config.mapVersion
    : `${config.mapVersion}@map-r${revision}-${digest.slice(0, 12)}`;
}

function normalizePublishedMapLayout(value, config = GUANGYANG_CONFIG) {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const expectedKeys = [
    "schemaVersion", "checkpoints", "targets", "storage", "distractors", "obstacles"
  ].sort();
  const objects = Array.isArray(config?.objectTaskOverlay?.objects) ? config.objectTaskOverlay.objects : [];
  const countForRole = role => objects.filter(item => item?.role === role).length;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !jsonStructuresEqual(keys, expectedKeys)
    || value.schemaVersion !== PUBLISHED_MAP_LAYOUT_SCHEMA_VERSION
    || !Array.isArray(value.checkpoints) || value.checkpoints.length !== (config?.checkpoints || []).length
    || !Array.isArray(value.targets) || value.targets.length !== countForRole("target")
    || !Array.isArray(value.distractors) || value.distractors.length !== countForRole("distractor")
    || !Array.isArray(value.obstacles) || value.obstacles.length !== countForRole("obstacle")) {
    throw new Error("已发布地图布局不兼容");
  }
  return {
    schemaVersion: PUBLISHED_MAP_LAYOUT_SCHEMA_VERSION,
    checkpoints: value.checkpoints.map((point, index) => (
      normalizePublishedMapPoint(point, `途径点 ${index + 1}`)
    )),
    targets: value.targets.map((point, index) => normalizePublishedMapPoint(point, `目标物 ${index + 1}`)),
    storage: normalizePublishedMapPoint(value.storage, "目标点"),
    distractors: value.distractors.map((point, index) => normalizePublishedMapPoint(point, `混淆物 ${index + 1}`)),
    obstacles: value.obstacles.map((point, index) => normalizePublishedMapPoint(point, `障碍物 ${index + 1}`))
  };
}

function normalizePublishedMapConfigEnvelope(payload, config = GUANGYANG_CONFIG) {
  const keys = payload && typeof payload === "object" && !Array.isArray(payload)
    ? Object.keys(payload).sort()
    : [];
  const expectedKeys = [
    "schemaVersion", "authoritative", "mapId", "baseMapVersion", "mapVersion",
    "revision", "updatedAt", "digest", "layout"
  ].sort();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !jsonStructuresEqual(keys, expectedKeys)
    || payload.schemaVersion !== PUBLISHED_MAP_CONFIG_SCHEMA_VERSION
    || payload.authoritative !== false
    || payload.mapId !== config?.mapId
    || payload.baseMapVersion !== config?.mapVersion
    || typeof payload.mapVersion !== "string" || !payload.mapVersion
    || !Number.isSafeInteger(payload.revision) || payload.revision < 0
    || (payload.updatedAt !== null && (!Number.isFinite(Date.parse(payload.updatedAt))
      || new Date(Date.parse(payload.updatedAt)).toISOString() !== payload.updatedAt))
    || (payload.revision === 0
      && (payload.updatedAt !== null || payload.mapVersion !== payload.baseMapVersion))
    || (payload.revision > 0 && payload.updatedAt === null)
    || !/^[a-f0-9]{64}$/.test(payload.digest || "")
    || payload.mapVersion !== expectedPublishedMapVersion(payload.revision, payload.digest, config)) {
    throw new Error("已发布地图配置响应不兼容");
  }
  return {
    schemaVersion: PUBLISHED_MAP_CONFIG_SCHEMA_VERSION,
    authoritative: false,
    mapId: payload.mapId,
    baseMapVersion: payload.baseMapVersion,
    mapVersion: payload.mapVersion,
    revision: payload.revision,
    updatedAt: payload.updatedAt,
    digest: payload.digest,
    layout: normalizePublishedMapLayout(payload.layout, config)
  };
}

function normalizePublishedMapBinding(value, expectedMapVersion = "", config = GUANGYANG_CONFIG) {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const expectedKeys = ["digest", "mapVersion", "revision", "schemaVersion"].sort();
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !jsonStructuresEqual(keys, expectedKeys)
    || value.schemaVersion !== PUBLISHED_MAP_BINDING_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !/^[a-f0-9]{64}$/.test(value.digest || "")
    || typeof value.mapVersion !== "string" || !value.mapVersion
    || value.mapVersion !== expectedPublishedMapVersion(value.revision, value.digest, config)
    || (expectedMapVersion && value.mapVersion !== expectedMapVersion)) {
    throw new Error("服务端场次的地图版本绑定不兼容");
  }
  return structuredClone(value);
}

function guangyangObjectOverlayFromLayout(layout, config = GUANGYANG_RUNTIME_CONFIG) {
  const overlay = structuredClone(config?.objectTaskOverlay || {});
  const positions = {
    target: layout.targets,
    distractor: layout.distractors,
    obstacle: layout.obstacles,
    storage: [layout.storage]
  };
  const roleIndexes = { target: 0, distractor: 0, obstacle: 0, storage: 0 };
  overlay.objects = (overlay.objects || []).map(item => ({
    ...item,
    position: [...positions[item.role][roleIndexes[item.role]++] ]
  }));
  overlay.zones = (overlay.zones || []).map(item => ({
    ...item,
    position: [...positions[item.role][roleIndexes[item.role]++] ]
  }));
  return overlay;
}

function guangyangConfigFromPublishedMap(mapConfig, baseConfig = GUANGYANG_RUNTIME_CONFIG) {
  const config = structuredClone(baseConfig);
  config.mapVersion = mapConfig.mapVersion;
  config.checkpoints = config.checkpoints.map((checkpoint, index) => ({
    ...checkpoint,
    position: [...mapConfig.layout.checkpoints[index]]
  }));
  config.objectTaskOverlay = guangyangObjectOverlayFromLayout(mapConfig.layout, config);
  config.task.deliveries = config.task.deliveries.map(delivery => (
    delivery.objectRole === "target" && delivery.destinationRole === "storage"
      ? { ...delivery, destination: [...mapConfig.layout.storage] }
      : delivery
  ));
  const overlay = normalizeGuangyangObjectTaskOverlay(config);
  config.task = buildGuangyangCompositeTask(config, overlay);
  config.mapConfig = {
    revision: mapConfig.revision,
    digest: mapConfig.digest,
    mapVersion: mapConfig.mapVersion
  };
  return config;
}

function guangyangMissionFromConfig(config) {
  const overlay = normalizeGuangyangObjectTaskOverlay(config);
  const task = config?.task?.type === "composite"
    ? structuredClone(config.task)
    : buildGuangyangCompositeTask(config, overlay);
  const mission = structuredClone(missions[guangyangMissionKeyForTaskId(config?.taskId)] || missions.guangyang);
  mission.title = config?.displayName || mission.title;
  mission.mapSize = Number(config?.world?.size) || mission.mapSize;
  mission.start = Array.isArray(config.start) ? [...config.start] : mission.start;
  mission.goal = Array.isArray(config.goal) ? [...config.goal] : mission.goal;
  mission.guidePath = [
    mission.start.slice(0, 2),
    ...(config.checkpoints || []).map(checkpoint => [...checkpoint.position]),
    [...mission.goal]
  ];
  mission.obstacles = (config.obstacles || []).map(obstacle => [...obstacle.position]);
  mission.objectObstacles = overlay.objects
    .filter(item => item.role === "obstacle")
    .map(item => ({ ...item, x: item.position[0], z: item.position[1] }));
  mission.objectZones = overlay.zones.map(item => ({ ...item }));
  mission.packageRadius = overlay.packageRadius;
  mission.packages = overlay.objects
    .filter(item => item.role === "target" || item.role === "distractor")
    .map(item => ({
      id: item.id,
      x: item.position[0],
      z: item.position[1],
      role: item.role,
      category: item.category,
      color: item.color,
      radius: item.radius
    }));
  mission.completion = {
    ...task,
    checkpointSource: "competition",
    checkpointRadius: task.checkpointRadius,
    goalRadius: task.goalRadius
  };
  mission.competition = { enabled: true, config };
  mission.publishedMapConfig = config.mapConfig ? structuredClone(config.mapConfig) : null;
  return mission;
}

const GUANGYANG_TRAINING_PROFILES = Object.freeze({
  target: Object.freeze({
    type: "target-delivery",
    title: "广阳岛识别练习：目标物投放",
    text: "在同一张广阳岛地图上，练习让 Python 程序读取摄像头结果、识别红色目标物并送入绿色存放点；练习不会训练模型或生成比赛成绩。",
    startSource: Object.freeze([365, 234]),
    focusRole: "target",
    destinationRole: "storage",
    summary: "红色目标物 → 绿色存放点",
    legend: Object.freeze([
      Object.freeze({ category: "目标物", label: "红色目标物", color: "#ef4444" }),
      Object.freeze({ category: "存放点", label: "绿色存放点", color: "#22c55e" })
    ]),
    checklist: Object.freeze(["观察到目标物", "夹取目标物", "送入存放点"])
  }),
  obstacle: Object.freeze({
    type: "obstacle-avoidance",
    title: "广阳岛识别练习：障碍物绕行",
    text: "在同一张广阳岛地图上，练习让 Python 程序读取黄黑障碍的类别、方向、距离和置信度，再规划其他道路安全绕开；练习不会训练模型或生成比赛成绩。",
    // Keep enough camera distance for the full yellow-black obstacle to remain in frame.
    startSource: Object.freeze([289, 424]),
    focusRole: "obstacle",
    summary: "黄黑障碍物 → 规划道路绕行",
    legend: Object.freeze([
      Object.freeze({ category: "障碍物", label: "黄黑障碍物", color: "#facc15" })
    ]),
    checklist: Object.freeze(["观察到障碍物", "通过绕行道路", "无碰撞抵达道路另一侧"])
  }),
  distractor: Object.freeze({
    type: "distractor-removal",
    title: "广阳岛识别练习：混淆物移出道路",
    text: "在同一张广阳岛地图上，练习让 Python 程序识别蓝色混淆物，夹取后把整个物体移出任意道路边界；不要把它当作目标物。练习不会训练模型或生成比赛成绩。",
    // Keep the complete blue package in the 4:3 sensor frame before approach.
    startSource: Object.freeze([380, 535]),
    focusRole: "distractor",
    summary: "蓝色混淆物 → 任意道路边界外",
    legend: Object.freeze([
      Object.freeze({ category: "混淆物", label: "蓝色混淆物", color: "#3b82f6" }),
      Object.freeze({ category: "道路传感", label: "道路边界（由 road_state 判断）", color: "#94a3b8" })
    ]),
    checklist: Object.freeze(["观察到混淆物", "夹取混淆物", "读取道路边界余量", "放到道路外"])
  })
});

function guangyangTrainingRoleItem(role, collection) {
  const records = collection === "zones" ? GUANGYANG_OBJECT_TASK.zones : GUANGYANG_OBJECT_TASK.objects;
  if (role === "offroad-removal") {
    return records.find(item => item.role === "offroad-removal")
      || records.find(item => item.role === "cleanup");
  }
  return records.find(item => item.role === role);
}

function guangyangHeadingToward(from, to) {
  return Math.atan2(-(Number(to[0]) - Number(from[0])), -(Number(to[1]) - Number(from[1])));
}

function buildGuangyangRoadClearanceTrainingCompletion(focusObject, config = GUANGYANG_RUNTIME_CONFIG) {
  const task = config?.task;
  const delivery = Array.isArray(task?.deliveries)
    ? task.deliveries.find(item => item?.objectRole === "distractor")
    : null;
  const requiredPackageIds = Array.isArray(delivery?.requiredPackageIds)
    ? delivery.requiredPackageIds.map(String)
    : [];
  const roads = task?.placementGeometry?.roads;
  if (task?.schemaVersion !== "chenlong.task/v5"
    || delivery?.destinationRole !== "offroad-removal"
    || delivery?.placementRule !== "road-edge-clearance"
    || !focusObject?.id
    || !requiredPackageIds.includes(String(focusObject.id))
    || !(Number(delivery.objectRadius) > 0)
    || !(Number(delivery.minimumRoadEdgeClearance) > 0)
    || !Array.isArray(roads) || roads.length === 0) {
    throw new Error("广阳岛混淆物训练缺少正式 v5 道路边界判定");
  }
  return {
    type: "offroad-removal",
    placementRule: "road-edge-clearance",
    objectRadius: Number(delivery.objectRadius),
    minimumRoadEdgeClearance: Number(delivery.minimumRoadEdgeClearance),
    placementGeometry: structuredClone(task.placementGeometry),
    requiredPackageIds: [String(focusObject.id)]
  };
}

function buildGuangyangTrainingMission(mode = "target") {
  const profile = GUANGYANG_TRAINING_PROFILES[mode] || GUANGYANG_TRAINING_PROFILES.target;
  const mission = structuredClone(missions.guangyang);
  const focusObject = guangyangTrainingRoleItem(profile.focusRole, "objects");
  const startPoint = guangyangSourcePointToWorld(profile.startSource) || mission.start.slice(0, 2);
  const focusPoint = focusObject?.position || mission.goal;
  // Training uses the exact Guangyang map and dimensions, but deliberately
  // drops the competition envelope so it cannot create sessions or scores.
  mission.guangyangSceneConfig = structuredClone(mission.competition?.config || GUANGYANG_CONFIG);
  delete mission.competition;
  mission.title = profile.title;
  mission.text = profile.text;
  mission.start = [...startPoint, guangyangHeadingToward(startPoint, focusPoint)];
  mission.trainingOnGuangyang = true;
  mission.objectTraining = {
    mode,
    type: profile.type,
    summary: profile.summary,
    legend: structuredClone(profile.legend),
    checklist: [...profile.checklist]
  };

  if (mode === "obstacle") {
    const routeSources = [
      [303, 450], [298, 430], [298, 388], [450, 388], [593, 388],
      [594, 470], [593, 556], [520, 556], [450, 557], [394, 559]
    ];
    mission.guidePath = routeSources.map(point => guangyangSourcePointToWorld(point));
    mission.goal = [...mission.guidePath.at(-1)];
    mission.goalLabel = "绕行终点";
    mission.goalCategory = "绕行终点";
    mission.goalColor = "#38bdf8";
    mission.completion = {
      type: "checkpoints",
      checkpointSource: "guidePath",
      checkpointRadius: 0.82,
      goalRadius: 0.92
    };
    return mission;
  }

  if (mode === "distractor") {
    mission.goal = null;
    mission.goalLabel = "道路边界外";
    mission.goalCategory = "道路外";
    mission.goalColor = "#f97316";
    mission.completion = buildGuangyangRoadClearanceTrainingCompletion(
      focusObject,
      mission.guangyangSceneConfig
    );
    return mission;
  }

  const destination = guangyangTrainingRoleItem(profile.destinationRole, "zones");
  mission.goal = destination?.position ? [...destination.position] : [...mission.goal];
  mission.goalLabel = "存放点";
  mission.goalCategory = "存放点";
  mission.goalColor = "#22c55e";
  mission.completion = {
    type: "delivery",
    deliveryRadius: Number(destination?.radius) > 0 ? Number(destination.radius) : 0.28,
    requiredPackageIds: focusObject ? [focusObject.id] : []
  };
  return mission;
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

let scene;
let camera;
let renderer;
let robotGroup;
let virtualCamera;
let virtualCameraTarget;
let virtualCameraCanvas;
let virtualCameraContext;
let virtualCameraPixels;
let virtualCameraImageData;
let virtualCameraCapturePromise = null;
let latestVirtualCameraFrameId = null;
let virtualCameraGeneration = 0;
// Host pacing is presentation only. No request means no simulator step.
let robotBackendMode = false;
let simulationVisionRunActive = false;
let simulationSceneReadyPromise = Promise.resolve();
let interactionAnimationPlan = null;
let raycaster;
let gridPlane;
let floorMesh;
let floorBaseMesh;
let floorGlowMesh;
let gridHelper;
let sunLight;
let running = false;
let stopRequested = false;
let missionCompletionStopRequested = false;
let pauseRequested = false;
let runToken = 0;
let actionCount = 0;
let blockedMoveCount = 0;
let lastMoveBlocked = false;
let realStopHazard = false;
let realRobotActionController = null;
let realStopPromise = null;
let realStopPending = false;
let activeRealCameraBaseUrl = null;
let realCameraGeneration = 0;
let placeMode = null;
let robotPose = { x: -3, z: -3, heading: 0 };
let obstacleMeshes = [];
let markerMeshes = [];
let missionWallMeshes = [];
let missionWallColliders = [];
let missionDecorationMeshes = [];
let guangyangReliefRoot = null;
let guangyangFlatMapPlane = null;
let guangyangTerrainMesh = null;
const guangyangSourceImagePromises = new Map();
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
let orbitPointerId = null;
let competitionMeshes = [];
let competitionTrafficLightVisuals = [];
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
let simulatorResizeObserver = null;
const directionVectorScratch = { x: 0, z: -1 };
let activeMission = structuredClone(missions.guangyang);
let currentMapStyle = "basic";
let competitionSession = null;
let latestCompetitionRecord = null;
let activeCompetitionServerSession = null;
let latestCompetitionSubmissionReceipt = null;
let latestCompetitionDraftRecordId = null;
let activeCompetitionBatch = null;
let competitionBatchOperation = null;
let activeRankedEvaluation = null;
let rankedEvaluationOperation = null;
let deterministicSimulator = null;
let navigationVisualPlayback = null;
let replayPlayer = null;
let replayRunning = false;
let replayStopRequested = false;
let replayRecordLoading = false;
let archivedReplayLoadPromise = null;
let archivedRecordLoadAbortController = null;
let archivedRecordLoadGeneration = 0;
let replayRecordLoadOperation = null;
let robotLinearSpeed = 0;
let robotSteering = 0;
let lastCompetitionHudAt = -Infinity;
let competitionTimeoutId = null;
let competitionSamplingIntervalId = null;
let competitionFinishInProgress = false;
let missionBuildGeneration = 0;
const ROBOT_RADIUS = 0.44;
const VIRTUAL_CAMERA_WIDTH = 640;
const VIRTUAL_CAMERA_HEIGHT = 480;
const VIRTUAL_CAMERA_FOV = 60;
const VIRTUAL_VISION_MODEL_SIZE = 640;
const TRAINING_VISION_PREVIEW_MAX_DPR = 2;
const VIRTUAL_PIXEL_CLASSES = Object.freeze(["target", "obstacle", "distractor", "storage-zone", "cleanup-zone"]);
const TRAINING_VISION_CATEGORIES = Object.freeze(["目标物", "障碍物", "混淆物", "存放点", "清理点"]);
const TRAINING_VISION_CATEGORY_LABELS = Object.freeze({
  target: "目标物",
  obstacle: "障碍物",
  distractor: "混淆物",
  "storage-zone": "存放点",
  "cleanup-zone": "清理点"
});
const TRAINING_VISION_CATEGORY_CODES = Object.freeze(Object.keys(TRAINING_VISION_CATEGORY_LABELS));
const TRAINING_VISION_CATEGORY_SET = new Set(TRAINING_VISION_CATEGORY_CODES);
const TRAINING_VISION_CATEGORY_BY_LABEL = new Map(
  Object.entries(TRAINING_VISION_CATEGORY_LABELS).map(([code, label]) => [label, code])
);

function normalizeTrainingVisionCategory(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (TRAINING_VISION_CATEGORY_SET.has(normalized)) return normalized;
  return TRAINING_VISION_CATEGORY_BY_LABEL.get(String(value ?? "").trim()) || null;
}

function trainingVisionCategoryLabel(category) {
  const code = normalizeTrainingVisionCategory(category);
  return code ? TRAINING_VISION_CATEGORY_LABELS[code] : "";
}
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
const GRAB_ACTION_DURATION_SECONDS = 6;
const RELEASE_ACTION_DURATION_SECONDS = 2;
const MIN_CONTROL_SECONDS = 0.08;
const DEFAULT_APPROACH_MAX_STEPS = 60;
const MAX_APPROACH_STEPS = 100;
const APPROACH_LOST_FRAME_LIMIT = 6;
const APPROACH_REAR_OBSTACLE_MARGIN = 0.08;
const MAX_PROGRAM_ACTION_SECONDS = 1200;
const MAX_PROGRAM_ACTION_COUNT = 3000;
const REAL_GRAB_DURATION_MS = GRAB_ACTION_DURATION_SECONDS * 1000;
const REAL_RELEASE_DURATION_MS = RELEASE_ACTION_DURATION_SECONDS * 1000;
const REAL_TURN_SECONDS_PER_90 = Object.freeze({ left: 0.5, right: 0.5 });
const REAL_DRIVE_CM_PER_SECOND = 15.625;
const REAL_MAX_TIMED_MOVE_SECONDS = 30;
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
  if (Number.isFinite(configuredSize)) return Math.max(MAP_SIZE, Math.min(MAX_RUNTIME_MAP_SIZE, configuredSize));
  return activeMission?.theme === "maze" ? MAZE_MAP_SIZE : MAP_SIZE;
}

function currentGuangyangSceneConfig() {
  if (activeMission?.environment !== "guangyang") return null;
  return activeMission?.competition?.config || activeMission?.guangyangSceneConfig || null;
}

function currentMapWidth() {
  const configuredWidth = Number(currentGuangyangSceneConfig()?.world?.width);
  return Number.isFinite(configuredWidth) ? configuredWidth : currentMapSize();
}

function currentMapDepth() {
  const configuredDepth = Number(currentGuangyangSceneConfig()?.world?.depth);
  return Number.isFinite(configuredDepth) ? configuredDepth : currentMapSize();
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

function currentPlayableBounds(radius = ROBOT_RADIUS) {
  const safeRadius = Math.max(0, Number(radius) || 0);
  return {
    minX: -currentMapWidth() / 2 + safeRadius,
    maxX: currentMapWidth() / 2 - safeRadius,
    minZ: -currentMapDepth() / 2 + safeRadius,
    maxZ: currentMapDepth() / 2 - safeRadius
  };
}

function simulationWorldDefinition({ includePackages = true } = {}) {
  const sourceShapes = includePackages
    ? robotCollisionShapes
    : robotCollisionShapes.filter(shape => shape.source !== "package");
  const colliders = sourceShapes.map((shape, index) => shape.type === "circle"
    ? {
        id: shape.id || `circle-${index + 1}`,
        type: "circle",
        x: Number(shape.x),
        z: Number(shape.z),
        radius: Number(shape.radius)
      }
    : {
        id: shape.id || `rect-${index + 1}`,
        type: "rect",
        x: Number(shape.rect?.x),
        z: Number(shape.rect?.z),
        width: Math.abs(Number(shape.rect?.w)),
        depth: Math.abs(Number(shape.rect?.h))
      });
  return {
    bounds: {
      minX: -currentMapWidth() / 2,
      maxX: currentMapWidth() / 2,
      minZ: -currentMapDepth() / 2,
      maxZ: currentMapDepth() / 2
    },
    colliders
  };
}

function simulationDefinition() {
  return {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: Number(activeMission?.competition?.randomSeed ?? 0) >>> 0,
    initialPose: { x: robotPose.x, z: robotPose.z, heading: robotPose.heading },
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: ROBOT_RADIUS,
      collisionSkin: MOVE_COLLISION_SKIN,
      maxLinearSpeed: 2.5,
      maxAngularSpeed: 2.8
    },
    world: simulationWorldDefinition({ includePackages: false })
  };
}

function packageInteractionDefinition() {
  const packages = ensureMissionPackages();
  const obstacleObjects = Array.isArray(activeMission.objectObstacles) ? activeMission.objectObstacles : [];
  const packageRadius = Number(activeMission.packageRadius) > 0 ? Number(activeMission.packageRadius) : PACKAGE_RADIUS;
  return {
    schemaVersion: "chenlong.package-interaction/v2",
    packageRadius,
    stackKeyDigits: 3,
    bounds: { ...simulationWorldDefinition().bounds },
    grab: {
      minForward: 0.38,
      maxForward: 1.35,
      maxLateral: 0.38
    },
    release: {
      forwardOffset: 1.1,
      lateralOffset: 0,
      stackSnapDistance: PACKAGE_STACK_SNAP_DISTANCE
    },
    packages: packages.map((record, index) => ({
      id: record.id,
      x: record.x,
      z: record.z,
      stackLevel: packageStackLevelForIndex(packages, index),
      role: packageCategory(record) === "distractor"
        ? "distractor"
        : packageCategory(record) === "obstacle"
          ? "obstacle"
          : "target",
      radius: Number(record.radius) > 0 ? Number(record.radius) : packageRadius
    })).concat(obstacleObjects.map((record, index) => ({
      id: String(record.id || `obstacle-${index + 1}`),
      x: Number(record.x ?? record.position?.[0]),
      z: Number(record.z ?? record.position?.[1]),
      stackLevel: 0,
      role: "obstacle",
      radius: Number(record.radius) > 0 ? Number(record.radius) : BLOCK_RADIUS
    })))
  };
}

function invalidateDeterministicSimulator() {
  deterministicSimulator = null;
  replayStopRequested = true;
}

function ensureDeterministicSimulator({ reset = false } = {}) {
  const Simulator = globalThis.CompetitionCore?.DeterministicSimulator;
  if (!Simulator) throw new Error("确定性仿真核心尚未加载。");
  if (reset || !deterministicSimulator) deterministicSimulator = new Simulator(simulationDefinition());
  else deterministicSimulator.setWorld(simulationWorldDefinition({ includePackages: true }));
  return deterministicSimulator;
}

function setRobotBackendMode(enabled) {
  if (running || competitionSession?.status === "running") {
    throw new Error("Cannot change robot backend mode during a run");
  }
  robotBackendMode = Boolean(enabled);
  return robotBackendMode;
}

async function ensureSimulationSceneReady() {
  // A new scene may replace the awaited promise while its old image loads.
  for (;;) {
    const generation = missionBuildGeneration;
    const pending = simulationSceneReadyPromise;
    await pending;
    if (generation === missionBuildGeneration && pending === simulationSceneReadyPromise) return;
  }
}

function simulationVisionContext() {
  return {
    tick: deterministicSimulator?.tick ?? competitionSession?.simulationTick ?? 0,
    stepMs: deterministicSimulator?.config.stepMs ?? competitionSession?.simulationDefinition?.stepMs ?? 20,
    stateRevision: competitionSession?.stateRevision ?? 0,
    generation: virtualCameraGeneration
  };
}

function beginSimulationVisionRun() {
  invalidateVirtualCameraFrame();
  window.CarVision.beginVirtualRun({ getContext: simulationVisionContext });
  simulationVisionRunActive = true;
}

function endSimulationVisionRun() {
  if (!simulationVisionRunActive) return;
  simulationVisionRunActive = false;
  virtualCameraGeneration += 1;
  virtualCameraCapturePromise = null;
  latestVirtualCameraFrameId = null;
  window.CarVision?.endVirtualRun?.();
}

function simulationSceneElapsedMs() {
  if (competitionSession?.simulationDefinition || simulationVisionRunActive || robotBackendMode) {
    const context = simulationVisionContext();
    return context.tick * context.stepMs;
  }
  return null;
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
  const records = rawPackages.flatMap(raw => {
    const x = Number(Array.isArray(raw) ? raw[0] : raw?.x);
    const z = Number(Array.isArray(raw) ? raw[1] : raw?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
    let id = !Array.isArray(raw) && raw?.id ? String(raw.id) : createPackageId();
    if (usedIds.has(id)) id = createPackageId();
    usedIds.add(id);
    const category = !Array.isArray(raw) && normalizeTrainingVisionCategory(raw?.category)
      ? normalizeTrainingVisionCategory(raw.category)
      : normalizeTrainingVisionCategory(source.packageCategory);
    const color = !Array.isArray(raw) && /^#[0-9a-f]{6}$/i.test(String(raw?.color || ""))
      ? String(raw.color)
      : null;
    const radius = !Array.isArray(raw) && Number(raw?.radius) > 0 ? Number(raw.radius) : null;
    return [{
      id,
      x,
      z,
      ...(category ? { category } : {}),
      ...(color ? { color } : {}),
      ...(radius ? { radius } : {})
    }];
  });
  records.forEach((record, index) => {
    if (Math.abs(record.x) < 0.0005) record.x = 0;
    if (Math.abs(record.z) < 0.0005) record.z = 0;
    const nearbyStack = records.slice(0, index).find(other => Math.hypot(other.x - record.x, other.z - record.z) < 0.01);
    if (nearbyStack) {
      record.x = nearbyStack.x;
      record.z = nearbyStack.z;
    }
  });
  return records;
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
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
  const robotCenterLimit = Math.max(0, halfSize - ROBOT_RADIUS);
  const obstacleCenterLimit = Math.max(0, halfSize - BLOCK_RADIUS);
  const packageCenterLimit = Math.max(0, halfSize - PACKAGE_RADIUS);
  let obstacles = Array.isArray(payload.obstacles)
    ? payload.obstacles.slice(0, MAX_SAVED_OBSTACLES).map(point => normalizeMapPoint(point, obstacleCenterLimit)).filter(Boolean)
    : [];
  let walls = Array.isArray(payload.walls)
    ? payload.walls.slice(0, MAX_SAVED_WALLS).flatMap(wall => {
        const center = normalizeMapPoint(wall, halfSize);
        const width = finiteNumber(wall?.[2]);
        const height = finiteNumber(wall?.[3]);
        if (!center || width == null || height == null || width <= 0 || height <= 0) return [];
        const limitedWidth = Math.min(width, mapSize);
        const limitedHeight = Math.min(height, mapSize);
        if (Math.abs(center[0]) + limitedWidth / 2 > halfSize || Math.abs(center[1]) + limitedHeight / 2 > halfSize) return [];
        return [[center[0], center[1], limitedWidth, limitedHeight]];
      })
    : [];
  if (payload.theme === "maze") {
    const protectedRoute = createMazeSolutionPath(MAZE_LAYOUT);
    obstacles = obstacles.filter(([x, z]) => !protectedRoute.some(([routeX, routeZ]) =>
      Math.hypot(routeX - x, routeZ - z) < ROBOT_RADIUS + BLOCK_RADIUS + 0.08
    ));
    walls = walls.filter(([x, z, w, h]) => !protectedRoute.some(([routeX, routeZ]) =>
      circleHitsRect(routeX, routeZ, ROBOT_RADIUS + 0.08, { x, z, w, h })
    ));
  }
  const limitedPackageSource = Array.isArray(payload.packages)
    ? { ...payload, packages: payload.packages.slice(0, MAX_SAVED_PACKAGES) }
    : payload;
  const packages = normalizePackageRecords(limitedPackageSource).filter(record =>
    Math.abs(record.x) <= packageCenterLimit && Math.abs(record.z) <= packageCenterLimit
  );
  const startPoint = normalizeMapPoint(payload.start, robotCenterLimit, 2);
  const startHeading = finiteNumber(payload.start?.[2], 0);
  const completion = payload.completion && typeof payload.completion === "object"
    ? structuredClone(payload.completion)
    : { type: "auto" };
  const usesDeliveryRadius = completion.type === "delivery" || (completion.type === "auto" && packages.length > 0);
  const configuredGoalRadius = usesDeliveryRadius
    ? finiteNumber(completion.deliveryRadius, 0.95)
    : finiteNumber(completion.goalRadius, 0.82);
  const goalVisualRadius = Math.max(ROBOT_RADIUS, Math.max(0.1, Math.min(5, configuredGoalRadius)));
  const goalCenterLimit = Math.max(0, halfSize - goalVisualRadius);
  return {
    obstacles,
    walls,
    packages,
    goal: normalizeMapPoint(payload.goal, goalCenterLimit),
    start: startPoint ? [startPoint[0], startPoint[1], startHeading] : null,
    guidePath: Array.isArray(payload.guidePath)
      ? payload.guidePath.slice(0, MAX_SAVED_GUIDE_POINTS).map(point => normalizeMapPoint(point, robotCenterLimit)).filter(Boolean)
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
  const normalizedX = Math.abs(Number(x)) < 0.0005 ? 0 : Number(x);
  const normalizedZ = Math.abs(Number(z)) < 0.0005 ? 0 : Number(z);
  return `${normalizedX.toFixed(3)}:${normalizedZ.toFixed(3)}`;
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

function packageCategory(record) {
  const category = normalizeTrainingVisionCategory(record?.category || activeMission?.packageCategory);
  if (category) return category;
  return activeMission?.packageVisual === "ball" ? "target" : null;
}

function heldObjectCategory() {
  if (!heldPackageId) return null;
  const record = ensureMissionPackages().find(item => item.id === heldPackageId);
  return packageCategory(record);
}

function interactionItemName() {
  const category = heldObjectCategory()
    || normalizeTrainingVisionCategory(activeMission?.packageCategory);
  if (category === "distractor") return "混淆物";
  if (category === "target" && activeMission?.objectTraining) return "目标物";
  if (category === "obstacle") return "障碍物";
  return activeMission?.packageVisual === "ball" ? "红球" : "纸箱包裹";
}

const pythonFeedback = document.querySelector("#pythonFeedback");
const pythonFeedbackTitle = document.querySelector("#pythonFeedbackTitle");
const pythonFeedbackMessage = document.querySelector("#pythonFeedbackMessage");
const pythonOutput = document.querySelector("#pythonOutput");
const pythonOutputContent = document.querySelector("#pythonOutputContent");
const codePanel = document.querySelector("#codePanel");
const pythonEditor = document.querySelector("#pythonEditor");
const pythonHighlight = document.querySelector("#pythonHighlight");
const lineNumbers = document.querySelector("#lineNumbers");
const loadExampleButton = document.querySelector("#loadExampleButton");
const exampleMenu = document.querySelector("#exampleMenu");
const exampleDropdown = document.querySelector("#exampleDropdown");
const visionApiHelpButton = document.querySelector("#visionApiHelpButton");
const visionApiHelp = document.querySelector("#visionApiHelp");
const appShell = document.querySelector(".app-shell");
const workspaceGrid = document.querySelector(".workspace-grid");
const workspaceSplitter = document.querySelector("#workspaceSplitter");
const sidePanel = document.querySelector(".side-panel");
const stateSceneSplitter = document.querySelector("#stateSceneSplitter");
const runButton = document.querySelector("#runButton");
const targetSelect = document.querySelector("#targetSelect");
const robotBaseUrlInput = document.querySelector("#robotBaseUrl");
const applyRobotIpButton = document.querySelector("#applyRobotIpButton");
const realCameraStage = document.querySelector("#realCameraStage");
const cameraStream = document.querySelector("#cameraStream");
const cameraStatus = document.querySelector("#cameraStatus");
const retryCameraButton = document.querySelector("#retryCameraButton");
const appStatusToast = document.querySelector("#appStatusToast");
const loadingOverlay = document.querySelector("#loadingOverlay");
const loadingBarFill = document.querySelector("#loadingBarFill");
const loadingStatus = document.querySelector("#loadingStatus");
const loadingHint = document.querySelector("#loadingHint");
const distanceText = document.querySelector("#distanceText");
const simulator = document.querySelector("#simulator");
const scenePanelTitleText = document.querySelector("#scenePanelTitleText");
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
const missionCard = document.querySelector(".mission-card");
const missionCardToggle = document.querySelector("#missionCardToggle");
const missionCardBody = document.querySelector("#missionCardBody");
const missionProgressLabel = document.querySelector("#missionProgressLabel");
const missionProgressValue = document.querySelector("#missionProgressValue");
const missionProgressBar = document.querySelector("#missionProgressBar");
const missionProgressHint = document.querySelector("#missionProgressHint");
const missionCompositeProgress = document.querySelector("#missionCompositeProgress");
const missionDeliveryProgress = document.querySelector("#missionDeliveryProgress");
const missionAvoidanceProgress = document.querySelector("#missionAvoidanceProgress");
const missionCheckpointProgress = document.querySelector("#missionCheckpointProgress");
const missionReturnProgress = document.querySelector("#missionReturnProgress");
const objectTrainingPanel = document.querySelector("#objectTrainingPanel");
const objectTrainingSummary = document.querySelector("#objectTrainingSummary");
const objectTrainingLegend = document.querySelector("#objectTrainingLegend");
const objectTrainingChecklist = document.querySelector("#objectTrainingChecklist");
const objectTrainingObservations = document.querySelector("#objectTrainingObservations");
const objectTrainingHolding = document.querySelector("#objectTrainingHolding");
const objectTrainingCoach = document.querySelector("#objectTrainingCoach");
const objectTrainingCoachMessage = document.querySelector("#objectTrainingCoachMessage");
const guangyangTrainingButton = document.querySelector("#guangyangTrainingButton");
const exitGuangyangTrainingButton = document.querySelector("#exitGuangyangTrainingButton");
const trainingVisionWorkbench = document.querySelector("#trainingVisionWorkbench");
const trainingVisionCanvas = document.querySelector("#trainingVisionCanvas");
const trainingVisionOverlay = document.querySelector("#trainingVisionOverlay");
const trainingVisionEmpty = document.querySelector("#trainingVisionEmpty");
const trainingVisionFrameLabel = document.querySelector("#trainingVisionFrameLabel");
const trainingVisionStatus = document.querySelector("#trainingVisionStatus");
const competitionHud = document.querySelector("#competitionHud");
const competitionHudBody = document.querySelector("#competitionHudBody");
const competitionHudToggle = document.querySelector("#competitionHudToggle");
const competitionScore = document.querySelector("#competitionScore");
const competitionBatchPanel = document.querySelector("#competitionBatchPanel");
const competitionBatchSourceState = document.querySelector("#competitionBatchSourceState");
const competitionBatchSlot = document.querySelector("#competitionBatchSlot");
const competitionBatchState = document.querySelector("#competitionBatchState");
const competitionBatchCurrentScore = document.querySelector("#competitionBatchCurrentScore");
const competitionBatchMeanScore = document.querySelector("#competitionBatchMeanScore");
const competitionBatchMinimumScore = document.querySelector("#competitionBatchMinimumScore");
const competitionBatchScore = document.querySelector("#competitionBatchScore");
const startCompetitionBatchButton = document.querySelector("#startCompetitionBatchButton");
const stopCompetitionBatchButton = document.querySelector("#stopCompetitionBatchButton");
const competitionBatchStatus = document.querySelector("#competitionBatchStatus");
const competitionBatchRecoveryPanel = document.querySelector("#competitionBatchRecoveryPanel");
const competitionBatchRecoveryCount = document.querySelector("#competitionBatchRecoveryCount");
const competitionBatchRecoveryItems = document.querySelector("#competitionBatchRecoveryItems");
const rankedEvaluationPanel = document.querySelector("#rankedEvaluationPanel");
const rankedEvaluationOpportunity = document.querySelector("#rankedEvaluationOpportunity");
const rankedEvaluationProgress = document.querySelector("#rankedEvaluationProgress");
const rankedEvaluationScore = document.querySelector("#rankedEvaluationScore");
const rankedEvaluationDeadline = document.querySelector("#rankedEvaluationDeadline");
const rankedEvaluationStatus = document.querySelector("#rankedEvaluationStatus");
const startRankedEvaluationButton = document.querySelector("#startRankedEvaluationButton");
const recoverRankedEvaluationButton = document.querySelector("#recoverRankedEvaluationButton");
const stopRankedEvaluationButton = document.querySelector("#stopRankedEvaluationButton");
const rankedEvaluationConfirmDialog = document.querySelector("#rankedEvaluationConfirmDialog");
const cancelRankedEvaluationButton = document.querySelector("#cancelRankedEvaluationButton");
const confirmRankedEvaluationButton = document.querySelector("#confirmRankedEvaluationButton");
const competitionRunState = document.querySelector("#competitionRunState");
const competitionTimer = document.querySelector("#competitionTimer");
const competitionTaskScore = document.querySelector("#competitionTaskScore");
const competitionRuleScore = document.querySelector("#competitionRuleScore");
const competitionAutoScore = document.querySelector("#competitionAutoScore");
const competitionEfficiencyScore = document.querySelector("#competitionEfficiencyScore");
const competitionTeamName = document.querySelector("#competitionTeamName");
const competitionLatestEvent = document.querySelector("#competitionLatestEvent");
const replayRunRecordButton = document.querySelector("#replayRunRecordButton");
const exportRunRecordButton = document.querySelector("#exportRunRecordButton");
const verifyRunRecordButton = document.querySelector("#verifyRunRecordButton");
const submitRunRecordButton = document.querySelector("#submitRunRecordButton");
const recordsNavLink = document.querySelector("#recordsNavLink");
const competitionRecordsDialog = document.querySelector("#competitionRecordsDialog");
const closeCompetitionRecordsButton = document.querySelector("#closeCompetitionRecordsButton");
const pendingCompetitionRecord = document.querySelector("#pendingCompetitionRecord");
const pendingCompetitionRecordTitle = document.querySelector("#pendingCompetitionRecordTitle");
const pendingCompetitionRecordSummary = document.querySelector("#pendingCompetitionRecordSummary");
const submitPendingRunRecordButton = document.querySelector("#submitPendingRunRecordButton");
const refreshCompetitionRecordsButton = document.querySelector("#refreshCompetitionRecordsButton");
const competitionRecordsStatus = document.querySelector("#competitionRecordsStatus");
const competitionRecordsList = document.querySelector("#competitionRecordsList");
const competitionTaskHighScores = document.querySelector("#competitionTaskHighScores");
const competitionVerifierHealth = document.querySelector("#competitionVerifierHealth");
const competitionVerifierResult = document.querySelector("#competitionVerifierResult");
const competitionSubmissionResult = document.querySelector("#competitionSubmissionResult");
const competitionRecordActionStatus = document.querySelector("#competitionRecordActionStatus");
const competitionTeamIdInput = document.querySelector("#competitionTeamId");
let resizingWorkspace = false;
let resizingStateScene = false;
let logCounter = 0;
let appStatusToastTimeoutId = null;
let appStatusToastGeneration = 0;
let selectedSavedMapId = "";
let pythonWorker = null;
let pythonReady = false;
let pythonRuntimeError = null;
let pendingPythonRun = null;
let pythonRequestId = 0;
let errorLineNumber = null;
let realtimeRun = null;
let serverVerificationRequestSerial = 0;
let serverVerificationInFlight = false;
let serverVerificationAbortController = null;
let competitionSessionRequestSerial = 0;
let competitionSessionAbortController = null;
let competitionSessionExpiryTimeoutId = null;
let competitionSubmissionRequestSerial = 0;
let competitionSubmissionInFlight = false;
let competitionSubmissionAbortController = null;
let competitionSubmissionOperation = null;
const competitionDraftSaveOperations = new WeakMap();
const pendingCompetitionDraftSaveOperations = new Set();
const competitionRecordSubmitOperations = new Map();
let competitionRecordsRequestSerial = 0;
let competitionRecordsAbortController = null;
let competitionRunStartPending = false;
let publishedGuangyangMapConfig = null;
let publishedGuangyangMission = null;
let publishedMapConfigRequest = null;
let publishedMapConfigRequestSerial = 0;
const publishedGuangyangMapConfigs = new Map();
const publishedGuangyangMissions = new Map();
const publishedMapConfigRequests = new Map();
const publishedMapConfigRequestSerials = new Map();
let guangyangAiAutonomyMode = false;
let competitionBatchRequestSerial = 0;
let competitionBatchAbortController = null;
let competitionBatchRestorePending = false;
let competitionBatchDiscoveryInFlight = false;
let competitionBatchDiscoveryCandidates = [];
let competitionBatchDiscoveryRequired = false;
let competitionBatchCreateOutcomeUnknown = null;
let rankedEvaluationRequestSerial = 0;
let rankedEvaluationAbortController = null;
let rankedEvaluationRestorePending = false;
let rankedEvaluationReady = false;
let rankedEvaluationReservationIncomplete = false;
let rankedEvaluationInterruptedCreate = null;
let pendingRankedEvaluationConfirmation = null;

const VERIFICATION_HEALTH_ENDPOINT = "/api/health";
const RUN_RECORD_VERIFICATION_ENDPOINT = "/api/v1/verify-run-record";
const PERSONAL_RECORDS_ENDPOINT = "/api/v1/records";
const COMPETITION_SESSION_ENDPOINT = "/api/v1/sessions";
const PUBLISHED_MAP_CONFIG_ENDPOINT = "/api/v1/map-config";
const COMPETITION_BATCH_ENDPOINT = "/api/v1/evaluation-batches";
const RANKED_COMPETITION_ID = "2026-r2-gyi-local-screening.1";
const RANKED_EVALUATION_ENDPOINT = `/api/v1/competitions/${RANKED_COMPETITION_ID}/ranked-evaluation`;
// The participant UI now uses one run and one score. The former five-run
// engines remain in the bundle only so older saved records stay compatible.
const FIVE_RUN_EVALUATION_UI_ENABLED = false;
const SESSION_SCHEMA_VERSION = "chenlong.local-session/v1";
const SUBMISSION_RECEIPT_SCHEMA_VERSION = "chenlong.submission-receipt/v1";
const RECORD_DRAFT_RECEIPT_SCHEMA_VERSION = "chenlong.record-draft-receipt/v1";
const RECORD_SUBMIT_RECEIPT_SCHEMA_VERSION = "chenlong.record-submit-receipt/v1";
const BATCH_API_RESPONSE_SCHEMA_VERSION = "chenlong.batch-api-response/v1";
const BATCH_OPEN_LIST_SCHEMA_VERSION = "chenlong.open-batch-list/v1";
const BATCH_EVALUATION_SCHEMA_VERSION = "chenlong.batch-evaluation/v1";
const BATCH_SLOT_LEASE_SCHEMA_VERSION = "chenlong.batch-slot-lease/v1";
const RANKED_EVALUATION_API_SCHEMA_VERSION = "chenlong.ranked-evaluation-api/v1";
const RANKED_SLOT_LEASE_SCHEMA_VERSION = "chenlong.ranked-slot-lease/v1";
const COMPETITION_BATCH_SLOT_COUNT = 5;
const COMPETITION_BATCH_DISCOVERY_LIMIT = 2;
const COMPETITION_BATCH_DISCOVERY_ORDER = "createdAt-desc,batchId-asc";
const VERIFICATION_HEALTH_TIMEOUT_MS = 2500;
const COMPETITION_SESSION_TIMEOUT_MS = 2500;
// Covers the server's bounded 60-second FIFO wait plus worker execution time.
const RUN_RECORD_VERIFICATION_TIMEOUT_MS = 120000;
const MAX_VERIFICATION_RESPONSE_LENGTH = 768 * 1024;
const MAX_ARCHIVED_REPLAY_RESPONSE_BYTES = 40 * 1024 * 1024;
const RUN_RECORD_COMPRESSION_THRESHOLD_BYTES = 128 * 1024;
const PYTHON_DRAFT_STORAGE_KEY = "chenlongPythonDraft/v1";
const COMPETITION_BATCH_RECOVERY_STORAGE_KEY = "chenlongCompetitionBatch/v1";
const RANKED_EVALUATION_PENDING_CREATE_STORAGE_KEY = "chenlongRankedEvaluationPendingCreate/v1";
const RANKED_EVALUATION_PENDING_CREATE_SCHEMA_VERSION = "chenlong.ranked-pending-create/v1";
const MAX_PYTHON_DRAFT_LENGTH = 128 * 1024;
const MAX_RANKED_SOURCE_BYTES = 128 * 1024;

function isCompetitionMission() {
  return Boolean(activeMission?.competition?.enabled && activeMission?.competition?.config);
}

function publishedMapConfigEndpoint(taskId) {
  return taskId === GUANGYANG_CONFIG?.taskId
    ? PUBLISHED_MAP_CONFIG_ENDPOINT
    : `${PUBLISHED_MAP_CONFIG_ENDPOINT}/${encodeURIComponent(taskId)}`;
}

function activeGuangyangChallengeConfig() {
  return guangyangConfigForTaskId(activeMission?.competition?.config?.taskId);
}

function cachePublishedGuangyangMission(taskId, mapConfig, mission) {
  publishedGuangyangMapConfigs.set(taskId, mapConfig);
  publishedGuangyangMissions.set(taskId, mission);
  // Preserve these long-standing aliases for challenge 1 and its saved-record
  // compatibility paths.
  if (taskId === GUANGYANG_CONFIG?.taskId) {
    publishedGuangyangMapConfig = mapConfig;
    publishedGuangyangMission = mission;
  }
}

function currentCompetitionTeamId() {
  const candidate = String(globalThis.chenlongCurrentUser?.id || "").trim();
  if (!/^usr_[a-f0-9]{32}$/.test(candidate)) {
    throw new Error("登录用户身份尚未就绪，请刷新页面后重试");
  }
  return candidate;
}

function currentPackageBaseY() {
  return PACKAGE_BASE_Y + (activeMission?.environment === "guangyang" ? 0.1 : 0);
}

function formatCompetitionTime(milliseconds) {
  const tenths = Math.max(0, Math.floor((Number(milliseconds) || 0) / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

function setVerificationServiceHealth(health, detail = "") {
  if (!competitionVerifierHealth) return;
  const labels = {
    checking: "探测中",
    online: "已连接",
    offline: "未连接"
  };
  const normalized = Object.prototype.hasOwnProperty.call(labels, health) ? health : "offline";
  competitionVerifierHealth.dataset.health = normalized;
  competitionVerifierHealth.parentElement?.setAttribute("data-health", normalized);
  competitionVerifierHealth.textContent = labels[normalized];
  competitionVerifierHealth.title = detail || (normalized === "offline"
    ? "未发现校验后端；本地仿真、回放和导出仍可正常使用。"
    : "");
}

function setCompetitionVerificationResult(status, message) {
  if (!competitionVerifierResult) return;
  competitionVerifierResult.dataset.status = status;
  competitionVerifierResult.textContent = message;
  competitionVerifierResult.title = message;
}

function setCompetitionRecordActionStatus(action, status, message) {
  if (!competitionRecordActionStatus) return;
  const normalizedStatus = ["idle", "checking", "success", "warning", "error"].includes(status)
    ? status
    : "idle";
  competitionRecordActionStatus.dataset.action = String(action || "record");
  competitionRecordActionStatus.dataset.status = normalizedStatus;
  competitionRecordActionStatus.setAttribute("aria-busy", String(normalizedStatus === "checking"));
  competitionRecordActionStatus.textContent = message;
  competitionRecordActionStatus.title = message;
}

function updateServerVerificationButton() {
  if (!verifyRunRecordButton) return;
  verifyRunRecordButton.disabled = serverVerificationInFlight;
  verifyRunRecordButton.title = latestCompetitionRecord
    ? "将本次运行记录发送到本地服务端重算"
    : "请先运行并结束一次比赛，再进行服务端校验";
  verifyRunRecordButton.classList.toggle("is-running", serverVerificationInFlight);
  verifyRunRecordButton.setAttribute("aria-busy", String(serverVerificationInFlight));
  const label = verifyRunRecordButton.querySelector("span");
  if (label) label.textContent = serverVerificationInFlight ? "正在服务端校验" : "服务端校验";
}

function recordMatchesCompetitionServerSession(record, session) {
  return Boolean(record && session
    && /^[A-Za-z0-9_-]{43}$/.test(session.submitToken || "")
    && Number.isFinite(Date.parse(session.expiresAt))
    && Date.parse(session.expiresAt) > Date.now()
    && record.schemaVersion === "chenlong.run-record/v4"
    && record.serverSessionId === session.sessionId
    && record.runId === session.runId
    && record.challengeDigest === session.challengeDigest);
}

function recordMatchesActiveServerSession(record = latestCompetitionRecord) {
  return recordMatchesCompetitionServerSession(record, activeCompetitionServerSession);
}

function normalizeRecordServiceError(payload, fallback) {
  const error = new Error(
    typeof payload?.error?.message === "string" && payload.error.message.trim()
      ? payload.error.message.trim().slice(0, 160)
      : fallback
  );
  if (typeof payload?.error?.code === "string") error.code = payload.error.code;
  return error;
}

function formatUploadByteLength(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function prepareCompetitionRecordUpload(record) {
  const serialized = JSON.stringify(record);
  const rawBytes = new TextEncoder().encode(serialized);
  const fallback = {
    body: serialized,
    contentEncoding: null,
    rawByteLength: rawBytes.byteLength,
    wireByteLength: rawBytes.byteLength
  };
  if (rawBytes.byteLength < RUN_RECORD_COMPRESSION_THRESHOLD_BYTES
    || typeof CompressionStream !== "function"
    || typeof Response !== "function") return fallback;
  try {
    const stream = new Blob([rawBytes]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = await new Response(stream).arrayBuffer();
    if (compressed.byteLength >= rawBytes.byteLength) return fallback;
    return {
      body: compressed,
      contentEncoding: "gzip",
      rawByteLength: rawBytes.byteLength,
      wireByteLength: compressed.byteLength
    };
  } catch (_error) {
    return fallback;
  }
}

function validateCompetitionDraftReceipt(payload, record, session) {
  return Boolean(payload
    && payload.schemaVersion === RECORD_DRAFT_RECEIPT_SCHEMA_VERSION
    && payload.authoritative === false
    && payload.recordState === "saved"
    && payload.sessionId === session.sessionId
    && /^sub_[a-f0-9]{32}$/.test(payload.recordId || "")
    && typeof payload.duplicate === "boolean"
    && Number.isFinite(Date.parse(payload.savedAt))
    && recordMatchesCompetitionServerSession(record, session));
}

function saveCompetitionRecordDraft(record, session) {
  if (!recordMatchesCompetitionServerSession(record, session)) return Promise.resolve(null);
  const existing = competitionDraftSaveOperations.get(record);
  if (existing) return existing.promise;
  const operation = { record, session, promise: null };
  operation.promise = (async () => {
    if (record === latestCompetitionRecord) {
      setCompetitionSubmissionResult("checking", "正在自动保存到“我的比赛记录”… · 尚未正式提交");
      setCompetitionRecordActionStatus("record", "checking", "正在自动保存本次运行记录…");
    }
    try {
      const upload = await prepareCompetitionRecordUpload(record);
      const { response, payload } = await requestVerificationEndpoint(
        `/api/v1/sessions/${encodeURIComponent(session.sessionId)}/drafts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(upload.contentEncoding ? { "Content-Encoding": upload.contentEncoding } : {}),
            Authorization: `Bearer ${session.submitToken}`
          },
          body: upload.body
        },
        RUN_RECORD_VERIFICATION_TIMEOUT_MS
      );
      if (!response.ok) {
        const fallback = response.status === 413
          ? `公网入口拒绝了本次运行记录（原始 ${formatUploadByteLength(upload.rawByteLength)}`
            + `，上传 ${formatUploadByteLength(upload.wireByteLength)}），请联系管理员提高上传限制`
          : `自动保存失败（HTTP ${response.status}）`;
        throw normalizeRecordServiceError(payload, fallback);
      }
      if (!validateCompetitionDraftReceipt(payload, record, session)) {
        throw new Error("自动保存服务响应不兼容");
      }
      if (record === latestCompetitionRecord) {
        latestCompetitionDraftRecordId = payload.recordId;
        setCompetitionSubmissionResult(
          "saved",
          `已自动保存到“我的比赛记录” · ${payload.recordId.slice(-8)} · 尚未正式提交`
        );
        setCompetitionRecordActionStatus(
          "record",
          "success",
          "运行记录已自动保存；可继续运行，也可到“我的比赛记录”逐条提交"
        );
        if (competitionRecordsDialog?.open) void loadCompetitionRecordsPreview();
      }
      return payload;
    } catch (error) {
      if (record === latestCompetitionRecord) {
        const message = String(error?.message || error).slice(0, 120);
        setCompetitionSubmissionResult("error", `自动保存失败：${message} · 不影响继续运行`);
        setCompetitionRecordActionStatus(
          "record",
          "warning",
          "自动保存失败；本次仍可导出备份，下一次运行不会被阻止"
        );
        addLog(`运行记录自动保存失败：${message}。`);
      }
      return null;
    } finally {
      pendingCompetitionDraftSaveOperations.delete(operation);
    }
  })();
  competitionDraftSaveOperations.set(record, operation);
  pendingCompetitionDraftSaveOperations.add(operation);
  return operation.promise;
}

function setCompetitionSubmissionResult(status, message) {
  if (!competitionSubmissionResult) return;
  competitionSubmissionResult.dataset.status = status;
  competitionSubmissionResult.textContent = message;
  competitionSubmissionResult.title = message;
}

function updateCompetitionSubmissionButton() {
  if (!submitRunRecordButton) return;
  const alreadySubmitted = latestCompetitionSubmissionReceipt
    && latestCompetitionSubmissionReceipt.recordRef === latestCompetitionRecord;
  submitRunRecordButton.disabled = competitionSubmissionInFlight;
  submitRunRecordButton.title = alreadySubmitted
    ? "本次运行记录已经存档"
    : recordMatchesActiveServerSession()
      ? "校验并保存本次比赛记录"
      : "请先运行并结束一次已绑定服务端场次的比赛";
  submitRunRecordButton.classList.toggle("is-running", competitionSubmissionInFlight);
  submitRunRecordButton.setAttribute("aria-busy", String(competitionSubmissionInFlight));
  const label = submitRunRecordButton.querySelector("span");
  if (label) {
    label.textContent = competitionSubmissionInFlight
      ? "正在提交存档"
      : alreadySubmitted ? "本次记录已存档" : "提交比赛存档";
  }
  if (competitionRecordsDialog?.open) renderPendingCompetitionRecord();
}

function resetCompetitionSubmissionState({ clearSession = false, message = null } = {}) {
  competitionSubmissionAbortController?.abort();
  competitionSubmissionAbortController = null;
  competitionSubmissionRequestSerial += 1;
  competitionSubmissionInFlight = false;
  latestCompetitionSubmissionReceipt = null;
  latestCompetitionDraftRecordId = null;
  if (clearSession) {
    clearTimeout(competitionSessionExpiryTimeoutId);
    competitionSessionExpiryTimeoutId = null;
    competitionSessionAbortController?.abort();
    competitionSessionAbortController = null;
    competitionSessionRequestSerial += 1;
    activeCompetitionServerSession = null;
  }
  setCompetitionSubmissionResult(
    "idle",
    message || (activeCompetitionServerSession
      ? "场次已绑定；运行结束后自动保存到“我的比赛记录” · authoritative: false"
      : "本次尚未绑定服务端场次 · authoritative: false")
  );
  updateCompetitionSubmissionButton();
}

function publishedLayoutFromRunDefinition(runDefinition, config = GUANGYANG_RUNTIME_CONFIG) {
  const taskDefinition = runDefinition?.taskDefinition;
  const interactionDefinition = runDefinition?.interactionDefinition;
  const packages = interactionDefinition?.packages;
  const byRole = new Map();
  (Array.isArray(packages) ? packages : []).forEach(item => {
    if (!byRole.has(item?.role)) byRole.set(item?.role, []);
    byRole.get(item?.role).push(item);
  });
  const targetDelivery = Array.isArray(taskDefinition?.deliveries)
    ? taskDefinition.deliveries.find(item => item?.objectRole === "target"
      && item?.destinationRole === "storage" && Array.isArray(item?.destination))
    : null;
  if (taskDefinition?.schemaVersion !== "chenlong.task/v5"
    || taskDefinition.type !== "composite"
    || !Array.isArray(taskDefinition.checkpoints) || taskDefinition.checkpoints.length !== (config?.checkpoints || []).length
    || !Array.isArray(taskDefinition.goal)
    || interactionDefinition?.schemaVersion !== "chenlong.package-interaction/v2"
    || !Array.isArray(packages)
    || !targetDelivery
    || !["target", "distractor", "obstacle"].every(role => byRole.has(role))) {
    throw new Error("服务端场次的广阳岛运行定义不完整");
  }
  return normalizePublishedMapLayout({
    schemaVersion: PUBLISHED_MAP_LAYOUT_SCHEMA_VERSION,
    checkpoints: taskDefinition.checkpoints.map(item => item?.position),
    targets: byRole.get("target").map(item => [item?.x, item?.z]),
    storage: targetDelivery.destination,
    distractors: byRole.get("distractor").map(item => [item?.x, item?.z]),
    obstacles: byRole.get("obstacle").map(item => [item?.x, item?.z])
  }, config);
}

function validateFrozenGuangyangRunDefinition(
  runDefinition,
  challenge,
  { requireCurrentRuntime = true, requirePublishedObjectAnchors = false } = {}
) {
  const simulationDefinition = runDefinition?.simulationDefinition;
  const taskDefinition = runDefinition?.taskDefinition;
  const interactionDefinition = runDefinition?.interactionDefinition;
  const expectedRunDefinitionKeys = [
    "simulationDefinition", "interactionDefinition", "taskDefinition", "ruleDefinition",
    "scoringDefinition", "visionDefinition", "navigationDefinition",
    "navigationControlDefinition", "timeLimitTicks"
  ].sort();
  const runDefinitionKeys = runDefinition && typeof runDefinition === "object" && !Array.isArray(runDefinition)
    ? Object.keys(runDefinition).sort()
    : [];
  if (!runDefinition || typeof runDefinition !== "object" || Array.isArray(runDefinition)
    || (requireCurrentRuntime && !jsonStructuresEqual(runDefinitionKeys, expectedRunDefinitionKeys))
    || simulationDefinition?.schemaVersion !== "chenlong.simulation/v1"
    || !simulationDefinition.initialPose
    || ![simulationDefinition.initialPose.x, simulationDefinition.initialPose.z,
      simulationDefinition.initialPose.heading].every(Number.isFinite)
    || !(Number(simulationDefinition.stepMs) > 0)
    || taskDefinition?.id !== challenge?.taskId
    || taskDefinition?.version !== challenge?.taskVersion
    || !runDefinition.ruleDefinition || typeof runDefinition.ruleDefinition !== "object"
    || !runDefinition.scoringDefinition || typeof runDefinition.scoringDefinition !== "object"
    || (requireCurrentRuntime
      && !jsonStructuresEqual(runDefinition.visionDefinition, globalThis.CompetitionCore?.VISION_DEFINITION))
    || (requireCurrentRuntime && !(
      jsonStructuresEqual(runDefinition.navigationDefinition, globalThis.CompetitionCore?.NAVIGATION_DEFINITION)
      || jsonStructuresEqual(runDefinition.navigationDefinition, globalThis.CompetitionCore?.PUBLIC_NAVIGATION_DEFINITION)
    ))
    || (requirePublishedObjectAnchors
      && !jsonStructuresEqual(runDefinition.navigationDefinition, globalThis.CompetitionCore?.PUBLIC_NAVIGATION_DEFINITION))
    || (requireCurrentRuntime && !jsonStructuresEqual(
      runDefinition.navigationControlDefinition,
      globalThis.CompetitionCore?.NAVIGATION_CONTROL_DEFINITION
    ))
    || !Number.isSafeInteger(runDefinition.timeLimitTicks) || runDefinition.timeLimitTicks < 1
    || !(Number(challenge?.timeLimitSeconds) > 0)
    || runDefinition.timeLimitTicks * simulationDefinition.stepMs
      !== challenge.timeLimitSeconds * 1000) {
    throw new Error("服务端场次的冻结运行定义不兼容");
  }
  const config = guangyangConfigForTaskId(challenge?.taskId);
  const layout = publishedLayoutFromRunDefinition(runDefinition, config);
  const roleCounts = { target: 0, distractor: 0, obstacle: 0 };
  const itemIds = new Set();
  interactionDefinition.packages.forEach(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || !item.id
      || !["target", "distractor", "obstacle"].includes(item.role)
      || itemIds.has(item.id)
      || !Number.isFinite(Number(item.x)) || !Number.isFinite(Number(item.z))
      || !(Number(item.radius) > 0)) {
      throw new Error("服务端场次的场景对象定义不兼容");
    }
    itemIds.add(item.id);
    roleCounts[item.role] += 1;
  });
  const configuredObjects = Array.isArray(config?.objectTaskOverlay?.objects) ? config.objectTaskOverlay.objects : [];
  for (const role of ["target", "distractor", "obstacle"]) {
    const expected = configuredObjects.filter(item => item?.role === role).length;
    if (expected < 1 || roleCounts[role] !== expected) {
      throw new Error("服务端场次的场景对象定义不完整");
    }
  }
  return layout;
}

function guangyangConfigFromFrozenRunDefinition(
  runDefinition,
  challenge,
  mapConfig = null,
  validationOptions = undefined
) {
  const layout = validateFrozenGuangyangRunDefinition(runDefinition, challenge, {
    ...(validationOptions || {}),
    // A published map has two frozen, supported navigation contracts.  The
    // teaching contract exposes route anchors for task objects; AI autonomy
    // deliberately does not, so student code must discover them visually.
    requirePublishedObjectAnchors: Boolean(mapConfig)
      && runDefinition?.navigationDefinition?.objectAnchorDisclosure === "road-anchor"
  });
  // The frozen definition below supplies the task-specific identifiers,
  // limits, objects and rules.  The shared base only contributes static
  // rendering metadata (roads, source image and labels).
  const config = structuredClone(guangyangConfigForTaskId(challenge?.taskId));
  config.taskId = challenge.taskId;
  config.taskVersion = challenge.taskVersion;
  config.mapId = challenge.mapId;
  config.mapVersion = challenge.mapVersion;
  config.ruleVersion = challenge.ruleVersion;
  config.displayName = challenge.displayName || config.displayName;
  config.timeLimitSeconds = challenge.timeLimitSeconds;
  config.start = [
    runDefinition.simulationDefinition.initialPose.x,
    runDefinition.simulationDefinition.initialPose.z,
    runDefinition.simulationDefinition.initialPose.heading
  ];
  config.goal = [...runDefinition.taskDefinition.goal];
  config.checkpoints = runDefinition.taskDefinition.checkpoints.map((checkpoint, index) => ({
    ...(config.checkpoints[index] || {}),
    id: checkpoint.id,
    position: [...checkpoint.position]
  }));
  config.objectTaskOverlay = guangyangObjectOverlayFromLayout(layout, config);
  const packagesByRole = new Map();
  runDefinition.interactionDefinition.packages.forEach(item => {
    if (!packagesByRole.has(item.role)) packagesByRole.set(item.role, []);
    packagesByRole.get(item.role).push(item);
  });
  const roleIndexes = { target: 0, distractor: 0, obstacle: 0 };
  config.objectTaskOverlay.objects = config.objectTaskOverlay.objects.map(item => ({
    ...item,
    id: packagesByRole.get(item.role)[roleIndexes[item.role]].id,
    position: [
      packagesByRole.get(item.role)[roleIndexes[item.role]].x,
      packagesByRole.get(item.role)[roleIndexes[item.role]++].z
    ],
    radius: packagesByRole.get(item.role)[roleIndexes[item.role] - 1].radius
  }));
  const targetDelivery = runDefinition.taskDefinition.deliveries
    .find(item => item.objectRole === "target" && item.destinationRole === "storage");
  config.objectTaskOverlay.zones = config.objectTaskOverlay.zones.map(item => item.role === "storage"
    ? { ...item, position: [...targetDelivery.destination], radius: targetDelivery.radius }
    : item);
  config.task = structuredClone(runDefinition.taskDefinition);
  config.rules = structuredClone(runDefinition.ruleDefinition);
  config.scoring = structuredClone(runDefinition.scoringDefinition);
  config.mapConfig = mapConfig ? structuredClone(mapConfig) : null;
  return config;
}

function normalizeServerSession(payload, expectedConfig, expectedAiAutonomyMode = false) {
  const source = payload?.session && typeof payload.session === "object"
    ? payload.session
    : payload;
  const session = source && typeof source === "object"
    ? { ...source, submitToken: payload?.submitToken ?? source.submitToken }
    : source;
  const runDefinition = payload?.runDefinition ?? session?.runDefinition;
  const mapConfig = normalizePublishedMapBinding(
    payload?.mapConfig ?? session?.mapConfig,
    session?.challenge?.mapVersion,
    expectedConfig
  );
  if (!session || typeof session !== "object" || Array.isArray(session)
    || session.schemaVersion !== SESSION_SCHEMA_VERSION
    || session.authoritative !== false
    || !/^ses_[a-f0-9]{32}$/.test(session.sessionId || "")
    || !/^run_[a-f0-9]{32}$/.test(session.runId || "")
    || !/^[a-f0-9]{64}$/.test(session.challengeDigest || "")
    || !/^[A-Za-z0-9_-]{43}$/.test(session.submitToken || "")
    || !/^tea_[a-f0-9]{32}$/.test(session.teamId || "")
    || !Number.isFinite(Date.parse(session.expiresAt))
    || Date.parse(session.expiresAt) <= Date.now()
    || session.challenge?.taskId !== expectedConfig?.taskId
    || session.challenge?.taskVersion !== expectedConfig?.taskVersion
    || session.challenge?.mapId !== expectedConfig?.mapId
    || session.challenge?.ruleVersion !== expectedConfig?.ruleVersion
    || session.challenge?.mapVersion !== mapConfig.mapVersion) {
    throw new Error("服务端场次响应不兼容");
  }
  const expectedSessionMode = expectedAiAutonomyMode ? AI_AUTONOMY_SESSION_MODE : "standard";
  if (typeof expectedAiAutonomyMode !== "boolean" || session.challenge?.sessionMode !== expectedSessionMode) {
    throw new Error("服务端场次的 AI 自主模式与当前选择不一致");
  }
  const aiAutonomyMode = runDefinition?.navigationDefinition?.objectAnchorDisclosure === "none";
  if (aiAutonomyMode !== expectedAiAutonomyMode) {
    throw new Error("服务端场次的 AI 自主模式与当前选择不一致");
  }
  const layout = validateFrozenGuangyangRunDefinition(runDefinition, session.challenge, {
    requirePublishedObjectAnchors: !aiAutonomyMode
  });
  return {
    sessionId: session.sessionId,
    runId: session.runId,
    challengeDigest: session.challengeDigest,
    teamId: session.teamId,
    taskId: session.challenge.taskId,
    challenge: structuredClone(session.challenge),
    mapConfig,
    mapLayout: layout,
    aiAutonomyMode,
    runDefinition: structuredClone(runDefinition),
    expiresAt: session.expiresAt,
    submitToken: session.submitToken,
    authoritative: false
  };
}

async function publishedMapLayoutDigest(layout) {
  const encoded = new TextEncoder().encode(canonicalJsonForMapConfig(layout));
  return sha256Hex(encoded);
}

async function assertPublishedMapDigest(layout, expectedDigest) {
  const actualDigest = await publishedMapLayoutDigest(layout);
  if (actualDigest !== expectedDigest) throw new Error("已发布地图配置完整性校验失败");
  return actualDigest;
}

function installGuangyangMissionSnapshot(mission, { announce = false, preserveCamera = false } = {}) {
  activeMission = structuredClone(mission);
  activeMission.packages = normalizePackageRecords(activeMission);
  renderMissionInfo();
  captureMissionBaseline();
  if (mapStyleSelect) mapStyleSelect.value = activeMission.mapStyle || "basic";
  setMapStyle(activeMission.mapStyle || "basic", false);
  setCompetitionHudVisibility();
  resetRobot();
  rebuildSceneObjects();
  initializeMissionAttempt();
  // Starting a new run freezes the current server map again, but that should
  // not discard a participant's orbit/zoom/view choice.  Real task or map
  // switches keep the default framing by leaving preserveCamera false.
  if (!preserveCamera) setCameraMode(isGuangyangAiAutonomyMission() ? "follow" : "iso");
  if (announce) {
    addLog(`已更新为管理员发布的地图（第 ${activeMission.publishedMapConfig?.revision || "?"} 版）。`, true);
    setStatus("已更新管理员发布的比赛地图");
  }
  return activeMission;
}

function officialGuangyangSceneCanRefresh(taskId = activeGuangyangChallengeConfig()?.taskId) {
  return activeMission?.environment === "guangyang"
    && !activeMission?.objectTraining
    && activeMission?.competition?.config?.taskId === taskId
    && !running
    && !competitionRunStartPending
    && !replayRunning
    && !managedFiveRunIsOpen()
    && !rankedEvaluationLocksWorkspace();
}

async function refreshPublishedGuangyangMap({ config = activeGuangyangChallengeConfig(), apply = true, announce = false } = {}) {
  const taskConfig = guangyangConfigForTaskId(config?.taskId);
  const taskId = taskConfig.taskId;
  const existingRequest = publishedMapConfigRequests.get(taskId);
  if (existingRequest) return existingRequest;
  const requestSerial = (publishedMapConfigRequestSerials.get(taskId) || 0) + 1;
  publishedMapConfigRequestSerials.set(taskId, requestSerial);
  const operation = (async () => {
    await globalThis.chenlongAuthReady;
    const { response, payload } = await requestVerificationEndpoint(
      publishedMapConfigEndpoint(taskId),
      { method: "GET" },
      COMPETITION_SESSION_TIMEOUT_MS
    );
    if (!response.ok) throw normalizeRecordServiceError(payload, `地图配置读取失败（HTTP ${response.status}）`);
    const mapConfig = normalizePublishedMapConfigEnvelope(payload, taskConfig);
    await assertPublishedMapDigest(mapConfig.layout, mapConfig.digest);
    if (requestSerial !== publishedMapConfigRequestSerials.get(taskId)) return publishedGuangyangMapConfigs.get(taskId) || null;
    const previous = publishedGuangyangMapConfigs.get(taskId);
    if (previous) {
      if (mapConfig.revision < previous.revision) {
        return previous;
      }
      if (mapConfig.revision === previous.revision
        && (mapConfig.digest !== previous.digest
          || mapConfig.mapVersion !== previous.mapVersion)) {
        throw new Error("已发布地图出现相同版本的内容冲突");
      }
    }
    const mission = guangyangMissionFromConfig(guangyangConfigFromPublishedMap(mapConfig, taskConfig));
    cachePublishedGuangyangMission(taskId, mapConfig, mission);
    if (apply && officialGuangyangSceneCanRefresh(taskId)) {
      installGuangyangMissionSnapshot(mission, { announce });
    }
    return mapConfig;
  })();
  publishedMapConfigRequests.set(taskId, operation);
  if (taskId === GUANGYANG_CONFIG?.taskId) publishedMapConfigRequest = operation;
  try {
    return await operation;
  } finally {
    if (publishedMapConfigRequests.get(taskId) === operation) publishedMapConfigRequests.delete(taskId);
    if (taskId === GUANGYANG_CONFIG?.taskId && publishedMapConfigRequest === operation) publishedMapConfigRequest = null;
  }
}

async function verifyAndCacheSingleSessionMap(session) {
  const taskId = session?.challenge?.taskId;
  const taskConfig = guangyangConfigForTaskId(taskId);
  const previous = publishedGuangyangMapConfigs.get(taskId);
  if (previous && session.mapConfig.revision < previous.revision) {
    throw new Error("服务端场次使用了早于当前已发布地图的版本");
  }
  await assertPublishedMapDigest(session.mapLayout, session.mapConfig.digest);
  if (previous && session.mapConfig.revision === previous.revision
    && (session.mapConfig.digest !== previous.digest
      || session.mapConfig.mapVersion !== previous.mapVersion)) {
    throw new Error("服务端场次与已发布地图版本冲突");
  }
  const config = guangyangConfigFromFrozenRunDefinition(
    session.runDefinition,
    session.challenge,
    session.mapConfig
  );
  const mission = guangyangMissionFromConfig(config);
  if (!previous || session.mapConfig.revision >= previous.revision) {
    const mapConfig = {
      schemaVersion: PUBLISHED_MAP_CONFIG_SCHEMA_VERSION,
      authoritative: false,
      mapId: session.challenge.mapId,
      baseMapVersion: taskConfig.mapVersion,
      mapVersion: session.mapConfig.mapVersion,
      revision: session.mapConfig.revision,
      updatedAt: null,
      digest: session.mapConfig.digest,
      layout: structuredClone(session.mapLayout)
    };
    cachePublishedGuangyangMission(taskId, mapConfig, structuredClone(mission));
  }
  return mission;
}

async function createCompetitionServerSession(config, { aiAutonomyMode = false } = {}) {
  const user = await globalThis.chenlongAuthReady;
  const userId = String(user?.id || "");
  if (!/^usr_[a-f0-9]{32}$/.test(userId)) throw new Error("登录用户身份无效");
  const taskId = String(config?.taskId || "");
  const requestSerial = ++competitionSessionRequestSerial;
  const abortController = new AbortController();
  competitionSessionAbortController?.abort();
  competitionSessionAbortController = abortController;
  activeCompetitionServerSession = null;
  let receivedIssuedSession = false;
  setCompetitionSubmissionResult("checking", "正在创建服务端比赛场次… · authoritative: false");
  updateCompetitionSubmissionButton();
  try {
    const { response, payload } = await requestVerificationEndpoint(
      COMPETITION_SESSION_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          mode: aiAutonomyMode ? AI_AUTONOMY_SESSION_MODE : "standard"
        })
      },
      COMPETITION_SESSION_TIMEOUT_MS,
      abortController.signal
    );
    if (requestSerial !== competitionSessionRequestSerial) return null;
    setVerificationServiceHealth("online");
    if (!response.ok) {
      throw new Error(payload?.error?.message || `创建场次失败（HTTP ${response.status}）`);
    }
    receivedIssuedSession = true;
    // The currently rendered mission may already carry a published map
    // version.  Bindings are always derived from the immutable base challenge
    // version, otherwise a published version would be suffixed a second time.
    const session = normalizeServerSession(payload, guangyangConfigForTaskId(taskId), aiAutonomyMode);
    await verifyAndCacheSingleSessionMap(session);
    activeCompetitionServerSession = session;
    clearTimeout(competitionSessionExpiryTimeoutId);
    competitionSessionExpiryTimeoutId = setTimeout(() => {
      if (activeCompetitionServerSession !== session) return;
      setCompetitionSubmissionResult("error", "服务端场次已过期；本地记录仍可导出 · authoritative: false");
      updateCompetitionSubmissionButton();
    }, Math.max(0, Date.parse(session.expiresAt) - Date.now()) + 10);
    setCompetitionSubmissionResult(
      "ready",
      `场次 ${session.sessionId.slice(-8)} 已绑定；运行结束后自动保存 · authoritative: false`
    );
    addLog(`已绑定本地赛务场次 ${session.sessionId.slice(-8)}（非权威存档）。`, true);
    return session;
  } catch (error) {
    if (requestSerial !== competitionSessionRequestSerial) return null;
    const message = String(error?.message || error).slice(0, 120);
    activeCompetitionServerSession = null;
    if (receivedIssuedSession) {
      setCompetitionSubmissionResult("error", `场次校验失败：${message} · 已阻止本次运行`);
      addLog(`服务端场次校验失败：${message}；为避免地图与判分不一致，已阻止本次运行。`);
      error.code = error.code || "SESSION_DEFINITION_MISMATCH";
      throw error;
    }
    setCompetitionSubmissionResult("error", `未绑定场次：${message} · 本地运行仍可继续`);
    addLog(`未能创建服务端场次：${message}；本次仅保留本地记录。`);
    if (aiAutonomyMode) {
      // The AI contract is defined by the server-frozen non-disclosure
      // navigation definition.  Do not silently fall back to a local scene
      // that could expose a different task API.
      throw error;
    }
    void probeVerificationService();
    return null;
  } finally {
    if (requestSerial === competitionSessionRequestSerial) {
      if (competitionSessionAbortController === abortController) competitionSessionAbortController = null;
      updateCompetitionSubmissionButton();
    }
  }
}

function resetCompetitionVerificationResult() {
  serverVerificationAbortController?.abort();
  serverVerificationAbortController = null;
  serverVerificationRequestSerial += 1;
  serverVerificationInFlight = false;
  setCompetitionVerificationResult(
    "idle",
    latestCompetitionRecord
      ? "待服务端校验 · authoritative: false"
      : "尚无运行记录 · authoritative: false"
  );
  updateServerVerificationButton();
}

function handleCompetitionAuthenticationFailure(response) {
  if (response?.status !== 401) return false;
  if (typeof globalThis.chenlongRedirectToLogin === "function") {
    globalThis.chenlongRedirectToLogin("authentication-required");
  }
  return true;
}

async function requestVerificationEndpoint(endpoint, options, timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options?.headers || {})
      },
      signal: controller.signal
    });
    handleCompetitionAuthenticationFailure(response);
    const text = await response.text();
    if (text.length > MAX_VERIFICATION_RESPONSE_LENGTH) {
      throw new Error("校验服务响应过大");
    }
    let payload = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        if (response.ok) throw new Error("校验服务返回了无效 JSON");
      }
    }
    return { response, payload };
  } catch (error) {
    if (error?.name === "AbortError") {
      if (externalSignal?.aborted) throw new DOMException("请求已取消", "AbortError");
      throw new Error("校验服务请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

function competitionBatchIsOpen(batch = activeCompetitionBatch?.batch) {
  if (typeof FIVE_RUN_EVALUATION_UI_ENABLED !== "undefined" && !FIVE_RUN_EVALUATION_UI_ENABLED) return false;
  return batch?.phase === "open" && Number.isSafeInteger(batch.nextSlotIndex);
}

function rankedEvaluationIsOpen(batch = activeRankedEvaluation?.batch) {
  if (typeof FIVE_RUN_EVALUATION_UI_ENABLED !== "undefined" && !FIVE_RUN_EVALUATION_UI_ENABLED) return false;
  return batch?.phase === "open" && Number.isSafeInteger(batch.nextSlotIndex);
}

function managedFiveRunIsOpen() {
  return rankedEvaluationIsOpen() || competitionBatchIsOpen();
}

function rankedEvaluationLocksWorkspace() {
  if (typeof FIVE_RUN_EVALUATION_UI_ENABLED !== "undefined" && !FIVE_RUN_EVALUATION_UI_ENABLED) return false;
  return rankedEvaluationIsOpen()
    || activeRankedEvaluation?.uiState === "creating"
    || (rankedEvaluationReservationIncomplete && Boolean(rankedEvaluationInterruptedCreate))
    || Boolean(rankedEvaluationOperation);
}

function competitionBatchScoreText(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(digits)} / ${COMPETITION_SCORE_MAXIMUM}`
    : `— / ${COMPETITION_SCORE_MAXIMUM}`;
}

function normalizeCompetitionBatchTeamId(value) {
  const normalized = String(value || "").trim().normalize("NFC");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(normalized)) {
    throw new Error("队伍编号需为 1-64 位字母、数字、点、下划线或短横线");
  }
  return normalized;
}

function competitionBatchHasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function competitionBatchErrorMessage(error, fallback = "练习五局暂时无法继续") {
  const code = String(error?.code || "");
  const messages = {
    OWNER_OPEN_BATCH_LIMIT_REACHED: "当前账号已有 2 个未完成练习；请先恢复，或逐个确认关闭后再创建。",
    OWNER_BATCH_RETENTION_LIMIT_REACHED: "当前账号的 20 次练习五局机会已用完；关闭已有练习也不会返还次数。",
    BATCH_LIMIT_REACHED: "当前练习服务的运行名额已满，请稍后重试。",
    BATCH_STORAGE_FULL: "练习记录空间暂时已满，请联系管理员。",
    BATCH_ARCHIVE_FULL: "练习记录数量已达服务上限，请联系管理员。",
    SESSION_LIMIT_REACHED: "当前可运行场次数已满，请稍后恢复或关闭其他运行。",
    SESSION_SCOPE_LIMIT_REACHED: "当前练习运行名额已满，请稍后重试；不会额外占用机会。",
    SESSION_ARCHIVE_FULL: "比赛存档空间已满，请联系赛事管理员。",
    ARCHIVE_STORAGE_FULL: "比赛存档空间已满，请联系赛事管理员。",
    BATCH_NOT_FOUND: "这个未完成练习已不存在，请重新查找。",
    BATCH_EXPIRED: "这个练习已到期，未完成局已按 0 分结算。",
    BATCH_OWNER_MISMATCH: "这个练习不属于当前登录账号。",
    BATCH_FINALIZED: "这个练习已经结束，不能继续运行。",
    SOURCE_LOCKED: "提交记录与本次练习锁定的源码不一致。",
    SLOT_NOT_CURRENT: "当前局已变化，请重新恢复练习进度。",
    SLOT_NOT_AVAILABLE: "当前局暂时不可用，请重新恢复练习进度。",
    SLOT_SESSION_MISMATCH: "本局记录与已恢复的场次不一致，尚未推进到下一局。",
    SLOT_ALREADY_FINALIZED: "本局已经结算，请重新恢复最新进度。",
    SLOT_LEASE_TEAM_MISMATCH: "本局已经绑定另一队伍编号，不能用当前编号覆盖。",
    INVALID_TEAM_ID: "请填写有效的队伍编号后再继续。",
    INVALID_BATCH_LIST_QUERY: "未完成练习查询与当前服务不兼容。",
    AUTHENTICATION_REQUIRED: "登录状态已失效，请重新登录后继续。"
  };
  if (messages[code]) return messages[code];
  const message = String(error?.message || "").trim();
  return (message || fallback).slice(0, 140);
}

function normalizeCompetitionBatchOpenList(payload) {
  const responseKeys = ["schemaVersion", "authoritative", "phase", "limit", "order", "batches"];
  if (!competitionBatchHasExactKeys(payload, responseKeys)
    || payload.schemaVersion !== BATCH_OPEN_LIST_SCHEMA_VERSION
    || payload.authoritative !== false
    || payload.phase !== "open"
    || payload.limit !== COMPETITION_BATCH_DISCOVERY_LIMIT
    || payload.order !== COMPETITION_BATCH_DISCOVERY_ORDER
    || !Array.isArray(payload.batches)
    || payload.batches.length > COMPETITION_BATCH_DISCOVERY_LIMIT) {
    throw new Error("未完成练习列表响应不兼容");
  }
  const batchKeys = ["batchId", "createdAt", "expiresAt", "nextSlotIndex", "sourceDigest", "summary"];
  const summaryKeys = [
    "slotCount", "finalizedCount", "pendingCount", "validCount", "invalidCount",
    "timeoutCount", "missingCount", "completedCount", "minScore", "meanScore",
    "batchScore", "collisionCount", "outOfBoundsCount"
  ];
  const seenBatchIds = new Set();
  let previous = null;
  payload.batches.forEach(item => {
    const summary = item?.summary;
    const createdAt = Date.parse(item?.createdAt);
    const expiresAt = Date.parse(item?.expiresAt);
    if (!competitionBatchHasExactKeys(item, batchKeys)
      || !/^bat_[a-f0-9]{32}$/.test(item.batchId || "")
      || seenBatchIds.has(item.batchId)
      || !/^[a-f0-9]{64}$/.test(item.sourceDigest || "")
      || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt
      || !Number.isSafeInteger(item.nextSlotIndex)
      || item.nextSlotIndex < 1 || item.nextSlotIndex > COMPETITION_BATCH_SLOT_COUNT
      || !competitionBatchHasExactKeys(summary, summaryKeys)) {
      throw new Error("未完成练习公开进度不兼容");
    }
    const countFields = [
      "finalizedCount", "pendingCount", "validCount", "invalidCount", "timeoutCount",
      "missingCount", "completedCount", "collisionCount", "outOfBoundsCount"
    ];
    if (summary.slotCount !== COMPETITION_BATCH_SLOT_COUNT
      || countFields.some(field => !Number.isSafeInteger(summary[field]) || summary[field] < 0)
      || summary.finalizedCount + summary.pendingCount !== COMPETITION_BATCH_SLOT_COUNT
      || summary.validCount + summary.invalidCount + summary.timeoutCount + summary.missingCount
        !== summary.finalizedCount
      || summary.completedCount > COMPETITION_BATCH_SLOT_COUNT
      || ![summary.minScore, summary.meanScore, summary.batchScore].every(
        score => typeof score === "number" && Number.isFinite(score)
          && score >= 0 && score <= COMPETITION_SCORE_MAXIMUM
      )) {
      throw new Error("未完成练习公开汇总不兼容");
    }
    if (previous && (createdAt > previous.createdAt
      || (createdAt === previous.createdAt && item.batchId.localeCompare(previous.batchId) < 0))) {
      throw new Error("未完成练习列表顺序不兼容");
    }
    seenBatchIds.add(item.batchId);
    previous = { batchId: item.batchId, createdAt };
  });
  return payload;
}

function normalizeCompetitionBatchEnvelope(payload) {
  const batch = payload?.batch;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.schemaVersion !== BATCH_API_RESPONSE_SCHEMA_VERSION
    || payload.authoritative !== false
    || !batch || typeof batch !== "object" || Array.isArray(batch)
    || batch.schemaVersion !== BATCH_EVALUATION_SCHEMA_VERSION
    || batch.authoritative !== false
    || !/^bat_[a-f0-9]{32}$/.test(batch.batchId || "")
    || !/^[a-f0-9]{64}$/.test(batch.sourceDigest || "")
    || batch.slotCount !== COMPETITION_BATCH_SLOT_COUNT
    || !Array.isArray(batch.slots)
    || batch.slots.length !== COMPETITION_BATCH_SLOT_COUNT
    || !["open", "finalized"].includes(batch.phase)) {
    throw new Error("练习五局服务响应不兼容");
  }
  const allowedStatuses = new Set(["pending", "valid", "invalid", "timeout", "missing"]);
  batch.slots.forEach((slot, index) => {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)
      || slot.slotIndex !== index + 1
      || typeof slot.final !== "boolean"
      || !allowedStatuses.has(slot.status)
      || typeof slot.score !== "number" || !Number.isFinite(slot.score)
      || slot.score < 0 || slot.score > COMPETITION_SCORE_MAXIMUM
      || typeof slot.completed !== "boolean") {
      throw new Error("练习五局单局结果不兼容");
    }
  });
  const summary = batch.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)
    || ![summary.meanScore, summary.minScore, summary.batchScore].every(
      score => typeof score === "number" && Number.isFinite(score)
        && score >= 0 && score <= COMPETITION_SCORE_MAXIMUM
    )) {
    throw new Error("练习五局汇总结果不兼容");
  }
  if (batch.phase === "open") {
    if (!Number.isSafeInteger(batch.nextSlotIndex)
      || batch.nextSlotIndex < 1 || batch.nextSlotIndex > COMPETITION_BATCH_SLOT_COUNT
      || !payload.currentSlot || payload.currentSlot.slotIndex !== batch.nextSlotIndex) {
      throw new Error("练习五局当前局不兼容");
    }
  } else if (batch.nextSlotIndex !== null || payload.currentSlot !== null) {
    throw new Error("练习五局结束状态不兼容");
  }
  return payload;
}

function normalizeCompetitionBatchLease(payload, expectedBatchId, expectedSlotIndex, expectedTeamId = "") {
  const envelope = normalizeCompetitionBatchEnvelope(payload);
  const lease = envelope.lease;
  const session = lease?.session;
  const runDefinition = lease?.runDefinition;
  const packages = runDefinition?.interactionDefinition?.packages;
  if (!lease || typeof lease !== "object" || Array.isArray(lease)
    || lease.schemaVersion !== BATCH_SLOT_LEASE_SCHEMA_VERSION
    || lease.authoritative !== false
    || typeof lease.recovered !== "boolean"
    || lease.batchId !== expectedBatchId
    || lease.slotIndex !== expectedSlotIndex
    || lease.layout?.slotIndex !== expectedSlotIndex
    || !session || typeof session !== "object" || Array.isArray(session)
    || session.schemaVersion !== SESSION_SCHEMA_VERSION
    || session.authoritative !== false
    || !/^ses_[a-f0-9]{32}$/.test(session.sessionId || "")
    || !/^run_[a-f0-9]{32}$/.test(session.runId || "")
    || !/^[a-f0-9]{64}$/.test(session.challengeDigest || "")
    || (expectedTeamId && session.teamId !== expectedTeamId)
    || !Number.isFinite(Date.parse(session.expiresAt))
    || Date.parse(session.expiresAt) <= Date.now()
    || session.challenge?.taskId !== GUANGYANG_RUNTIME_CONFIG?.taskId
    || session.challenge?.taskVersion !== GUANGYANG_RUNTIME_CONFIG?.taskVersion
    || session.challenge?.mapId !== GUANGYANG_RUNTIME_CONFIG?.mapId
    || session.challenge?.mapVersion !== GUANGYANG_RUNTIME_CONFIG?.mapVersion
    || session.challenge?.ruleVersion !== GUANGYANG_RUNTIME_CONFIG?.ruleVersion
    || !runDefinition || typeof runDefinition !== "object" || Array.isArray(runDefinition)
    || runDefinition.taskDefinition?.schemaVersion !== "chenlong.task/v5"
    || !Array.isArray(packages) || packages.length !== 3) {
    throw new Error("当前局租约响应不兼容");
  }
  const roles = new Set();
  packages.forEach(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || !item.id
      || !["target", "distractor", "obstacle"].includes(item.role)
      || roles.has(item.role)
      || !Number.isFinite(Number(item.x)) || !Number.isFinite(Number(item.z))
      || !(Number(item.radius) > 0)) {
      throw new Error("当前局场景对象定义不兼容");
    }
    roles.add(item.role);
  });
  if (roles.size !== 3) throw new Error("当前局场景对象定义不完整");
  return { envelope, lease };
}

const RANKED_BATCH_KEYS = Object.freeze([
  "schemaVersion", "authoritative", "batchId", "sourceDigest", "commitmentDigest",
  "phase", "finalizationReason", "nextSlotIndex", "slotCount", "slots", "summary", "ranking"
]);
const RANKED_SUMMARY_KEYS = Object.freeze([
  "slotCount", "finalizedCount", "pendingCount", "validCount", "invalidCount",
  "timeoutCount", "missingCount", "completedCount", "minScore", "meanScore",
  "batchScore", "collisionCount", "outOfBoundsCount"
]);
const RANKED_RANKING_KEYS = Object.freeze([
  "batchScore", "completedCount", "validCount", "minScore", "meanScore",
  "invalidCount", "missingCount", "timeoutCount", "collisionCount", "outOfBoundsCount"
]);
const RANKED_POLICY_KEYS = Object.freeze([
  "schemaVersion", "purpose", "competitionId", "catalogVersion",
  "selectionPolicyVersion", "rankedFormVersion", "scoreMaximum", "slotCount"
]);
const RANKED_CURRENT_SLOT_KEYS = Object.freeze([
  "schemaVersion", "catalogVersion", "mapId", "mapVersion", "slotIndex", "sequenceLength", "layoutCommitment"
]);

function rankedScoreIsValid(value) {
  return typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= COMPETITION_SCORE_MAXIMUM;
}

function rankedCountIsValid(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function rankedIsoTimestampIsValid(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function rankedSourceFitsByteLimit(source) {
  return typeof source === "string"
    && typeof TextEncoder === "function"
    && new TextEncoder().encode(source).byteLength <= MAX_RANKED_SOURCE_BYTES;
}

function rankedEvaluationReservationIsIncomplete(error) {
  return Number(error?.status) === 503
    && String(error?.code || "") === "RANKED_ATTEMPT_RESERVATION_INCOMPLETE";
}

function rememberRankedEvaluationPendingCreate(source, teamId) {
  const normalizedTeamId = normalizeCompetitionBatchTeamId(teamId);
  if (typeof source !== "string" || !source || !rankedSourceFitsByteLimit(source)) {
    throw new Error("待恢复筛选源码不兼容");
  }
  const pending = { source, teamId: normalizedTeamId };
  const serialized = JSON.stringify({
    schemaVersion: RANKED_EVALUATION_PENDING_CREATE_SCHEMA_VERSION,
    source: pending.source,
    teamId: pending.teamId
  });
  try {
    sessionStorage.setItem(RANKED_EVALUATION_PENDING_CREATE_STORAGE_KEY, serialized);
    if (sessionStorage.getItem(RANKED_EVALUATION_PENDING_CREATE_STORAGE_KEY) !== serialized) {
      throw new Error("pending create storage did not round-trip");
    }
  } catch (_error) {
    throw new Error("浏览器无法保存筛选恢复信息，创建请求未发送；请释放当前标签页存储空间后重试");
  }
  rankedEvaluationInterruptedCreate = pending;
  return pending;
}

function clearRankedEvaluationPendingCreate() {
  rankedEvaluationInterruptedCreate = null;
  try { sessionStorage.removeItem(RANKED_EVALUATION_PENDING_CREATE_STORAGE_KEY); } catch (_error) {}
}

function readRankedEvaluationPendingCreate() {
  try {
    const value = JSON.parse(sessionStorage.getItem(RANKED_EVALUATION_PENDING_CREATE_STORAGE_KEY) || "null");
    if (!competitionBatchHasExactKeys(value, ["schemaVersion", "source", "teamId"])
      || value.schemaVersion !== RANKED_EVALUATION_PENDING_CREATE_SCHEMA_VERSION
      || typeof value.source !== "string" || !value.source
      || !rankedSourceFitsByteLimit(value.source)
      || normalizeCompetitionBatchTeamId(value.teamId) !== value.teamId) {
      clearRankedEvaluationPendingCreate();
      return null;
    }
    rankedEvaluationInterruptedCreate = { source: value.source, teamId: value.teamId };
    return rankedEvaluationInterruptedCreate;
  } catch (_error) {
    clearRankedEvaluationPendingCreate();
    return null;
  }
}

function restoreRankedEvaluationInterruptedDraft() {
  const pending = readRankedEvaluationPendingCreate();
  if (!pending) return null;
  if (activeMission?.environment !== "guangyang" || activeMission?.objectTraining) {
    loadMission("guangyang", { batchInternal: true });
  }
  pythonEditor.value = pending.source;
  if (competitionTeamIdInput) competitionTeamIdInput.value = pending.teamId;
  updateLineNumbers();
  renderPythonHighlight();
  persistPythonDraft();
  return pending;
}

function normalizeRankedBatchProjection(batch, currentSlot) {
  if (!competitionBatchHasExactKeys(batch, RANKED_BATCH_KEYS)
    || !competitionBatchHasExactKeys(batch.summary, RANKED_SUMMARY_KEYS)
    || !competitionBatchHasExactKeys(batch.ranking, RANKED_RANKING_KEYS)
    || !RANKED_SUMMARY_KEYS.filter(field => !["minScore", "meanScore", "batchScore"].includes(field))
      .every(field => rankedCountIsValid(batch.summary[field]))
    || ![batch.summary.minScore, batch.summary.meanScore, batch.summary.batchScore].every(rankedScoreIsValid)
    || batch.summary.slotCount !== COMPETITION_BATCH_SLOT_COUNT
    || batch.summary.finalizedCount + batch.summary.pendingCount !== COMPETITION_BATCH_SLOT_COUNT
    || batch.summary.validCount + batch.summary.invalidCount + batch.summary.timeoutCount
      + batch.summary.missingCount !== batch.summary.finalizedCount
    || batch.summary.completedCount > COMPETITION_BATCH_SLOT_COUNT
    || !RANKED_RANKING_KEYS.every(field => (
      ["batchScore", "minScore", "meanScore"].includes(field)
        ? rankedScoreIsValid(batch.ranking[field])
        : rankedCountIsValid(batch.ranking[field])
    ))) {
    throw new Error("筛选五局公开汇总不兼容");
  }
  const envelope = normalizeCompetitionBatchEnvelope({
    schemaVersion: BATCH_API_RESPONSE_SCHEMA_VERSION,
    authoritative: false,
    batch,
    currentSlot
  });
  if (batch.phase === "open") {
    if (!competitionBatchHasExactKeys(currentSlot, RANKED_CURRENT_SLOT_KEYS)
      || currentSlot.sequenceLength !== COMPETITION_BATCH_SLOT_COUNT
      || currentSlot.slotIndex !== batch.nextSlotIndex
      || !/^[a-f0-9]{64}$/.test(currentSlot.layoutCommitment || "")) {
      throw new Error("筛选五局当前局公开信息不兼容");
    }
  }
  return { batch: envelope.batch, currentSlot: envelope.currentSlot };
}

function normalizeRankedCompetitionMetadata(value) {
  if (!competitionBatchHasExactKeys(value, ["competitionId", "displayName", "purpose", "scoreMaximum"])
    || value.competitionId !== RANKED_COMPETITION_ID
    || value.displayName !== "筛选五局（本地参考）"
    || value.purpose !== "ranked"
    || value.scoreMaximum !== COMPETITION_SCORE_MAXIMUM) {
    throw new Error("筛选五局赛季信息不兼容");
  }
  return value;
}

function normalizeRankedPolicy(value) {
  if (!competitionBatchHasExactKeys(value, RANKED_POLICY_KEYS)
    || value.schemaVersion !== "chenlong.ranked-evaluation-policy/v1"
    || value.purpose !== "ranked"
    || value.competitionId !== RANKED_COMPETITION_ID
    || ![60, COMPETITION_SCORE_MAXIMUM].includes(value.scoreMaximum)
    || value.slotCount !== COMPETITION_BATCH_SLOT_COUNT
    || ![value.catalogVersion, value.selectionPolicyVersion, value.rankedFormVersion]
      .every(item => typeof item === "string" && item.length > 0 && item.length <= 128)) {
    throw new Error("筛选五局冻结规则不兼容");
  }
  return value;
}

function normalizeRankedAnonymousResult(value, expectedParticipantId) {
  const qualityKeys = [
    "slotCount", "finalizedCount", "completedCount", "validCount", "invalidCount",
    "timeoutCount", "missingCount", "collisionCount", "outOfBoundsCount"
  ];
  if (!competitionBatchHasExactKeys(value, ["rank", "anonymousParticipantId", "score", "quality", "ranking"])
    || !Number.isSafeInteger(value.rank) || value.rank < 1
    || value.anonymousParticipantId !== expectedParticipantId
    || !competitionBatchHasExactKeys(value.score, ["value", "mean", "minimum", "maximum"])
    || ![value.score.value, value.score.mean, value.score.minimum].every(rankedScoreIsValid)
    || value.score.maximum !== COMPETITION_SCORE_MAXIMUM
    || !competitionBatchHasExactKeys(value.quality, qualityKeys)
    || !qualityKeys.every(field => rankedCountIsValid(value.quality[field]))
    || value.quality.slotCount !== COMPETITION_BATCH_SLOT_COUNT
    || value.quality.finalizedCount !== COMPETITION_BATCH_SLOT_COUNT
    || value.quality.validCount + value.quality.invalidCount + value.quality.timeoutCount
      + value.quality.missingCount !== COMPETITION_BATCH_SLOT_COUNT
    || !competitionBatchHasExactKeys(value.ranking, RANKED_RANKING_KEYS)
    || !RANKED_RANKING_KEYS.every(field => (
      ["batchScore", "minScore", "meanScore"].includes(field)
        ? rankedScoreIsValid(value.ranking[field])
        : rankedCountIsValid(value.ranking[field])
    ))) {
    throw new Error("筛选五局名次结果不兼容");
  }
  return value;
}

function normalizeRankedEvaluationProjection(value, { owner = false } = {}) {
  const expectedKeys = owner
    ? ["purpose", "competitionId", "lockedTeamId", "evaluationPolicy", "createdAt", "expiresAt",
      "batch", "currentSlot", "anonymousParticipantId", "lockedSource", "result"]
    : ["purpose", "competitionId", "lockedTeamId", "evaluationPolicy", "batch", "currentSlot"];
  if (!competitionBatchHasExactKeys(value, expectedKeys)
    || value.purpose !== "ranked"
    || value.competitionId !== RANKED_COMPETITION_ID) {
    throw new Error("筛选五局状态不兼容");
  }
  const lockedTeamId = normalizeCompetitionBatchTeamId(value.lockedTeamId);
  normalizeRankedPolicy(value.evaluationPolicy);
  const projected = normalizeRankedBatchProjection(value.batch, value.currentSlot);
  const normalized = {
    purpose: "ranked",
    competitionId: RANKED_COMPETITION_ID,
    lockedTeamId,
    evaluationPolicy: value.evaluationPolicy,
    batch: projected.batch,
    currentSlot: projected.currentSlot
  };
  if (!owner) return normalized;
  if (typeof value.lockedSource !== "string"
    || !/^participant_[a-f0-9]{32}$/.test(value.anonymousParticipantId || "")
    || !rankedIsoTimestampIsValid(value.createdAt)
    || !rankedIsoTimestampIsValid(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    throw new Error("筛选五局账号恢复信息不兼容");
  }
  if (projected.batch.phase === "finalized") {
    normalizeRankedAnonymousResult(value.result, value.anonymousParticipantId);
  } else if (value.result !== null) {
    throw new Error("进行中的筛选五局不能提前返回名次");
  }
  return {
    ...normalized,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    anonymousParticipantId: value.anonymousParticipantId,
    lockedSource: value.lockedSource,
    result: value.result
  };
}

function normalizeRankedEvaluationResponse(payload, kind) {
  const topKeys = {
    me: ["schemaVersion", "authoritative", "competition", "evaluation"],
    create: ["schemaVersion", "authoritative", "competition", "evaluation", "created"],
    detail: ["schemaVersion", "authoritative", "competition", "evaluation"],
    lease: ["schemaVersion", "authoritative", "competition", "evaluation", "lease"],
    submit: ["schemaVersion", "authoritative", "competition", "evaluation", "duplicate", "submission"],
    close: ["schemaVersion", "authoritative", "competition", "evaluation"]
  }[kind];
  if (!topKeys || !competitionBatchHasExactKeys(payload, topKeys)
    || payload.schemaVersion !== RANKED_EVALUATION_API_SCHEMA_VERSION
    || payload.authoritative !== false) {
    throw new Error("筛选五局服务响应不兼容");
  }
  normalizeRankedCompetitionMetadata(payload.competition);
  if (kind === "me" && payload.evaluation === null) return { ...payload, evaluation: null };
  const evaluation = normalizeRankedEvaluationProjection(payload.evaluation, { owner: true });
  if (kind === "create" && typeof payload.created !== "boolean") {
    throw new Error("筛选五局创建状态不兼容");
  }
  if (kind === "submit" && (typeof payload.duplicate !== "boolean"
    || payload.submission?.schemaVersion !== SUBMISSION_RECEIPT_SCHEMA_VERSION
    || payload.submission?.authoritative !== false
    || typeof payload.submission?.duplicate !== "boolean")) {
    throw new Error("筛选五局提交回执不兼容");
  }
  return { ...payload, evaluation };
}

function normalizeRankedLeaseResponse(payload, expectedBatchId, expectedSlotIndex, expectedTeamId) {
  const envelope = normalizeRankedEvaluationResponse(payload, "lease");
  const lease = envelope.lease;
  const session = lease?.session;
  const runDefinition = lease?.runDefinition;
  const simulationDefinition = runDefinition?.simulationDefinition;
  const interactionDefinition = runDefinition?.interactionDefinition;
  const taskDefinition = runDefinition?.taskDefinition;
  const packages = runDefinition?.interactionDefinition?.packages;
  const expectedSessionKeys = [
    "schemaVersion", "sessionId", "runId", "teamId", "challenge", "challengeDigest",
    "createdAt", "expiresAt", "status", "submissionCount", "maxSubmissions", "authoritative", "ownerUserId"
  ];
  const expectedChallengeKeys = [
    "taskId", "taskVersion", "mapId", "mapVersion", "ruleVersion", "displayName", "timeLimitSeconds"
  ];
  const expectedRunDefinitionKeys = [
    "visionDefinition", "navigationDefinition", "navigationControlDefinition",
    "simulationDefinition", "interactionDefinition", "taskDefinition", "ruleDefinition",
    "scoringDefinition", "timeLimitTicks"
  ];
  const expectedPackageKeys = ["id", "x", "z", "stackLevel", "role", "radius"];
  if (!competitionBatchHasExactKeys(lease, [
    "schemaVersion", "authoritative", "recovered", "competitionId", "batchId",
    "slotIndex", "layout", "session", "runDefinition"
  ])
    || lease.schemaVersion !== RANKED_SLOT_LEASE_SCHEMA_VERSION
    || lease.authoritative !== false
    || typeof lease.recovered !== "boolean"
    || lease.competitionId !== RANKED_COMPETITION_ID
    || lease.batchId !== expectedBatchId
    || lease.slotIndex !== expectedSlotIndex
    || !competitionBatchHasExactKeys(lease.layout, RANKED_CURRENT_SLOT_KEYS)
    || lease.layout.slotIndex !== expectedSlotIndex
    || !RANKED_CURRENT_SLOT_KEYS.every(field => lease.layout[field] === envelope.evaluation.currentSlot?.[field])
    || !competitionBatchHasExactKeys(session, expectedSessionKeys)
    || session.schemaVersion !== SESSION_SCHEMA_VERSION
    || session.authoritative !== false
    || !/^usr_[a-f0-9]{32}$/.test(session.ownerUserId || "")
    || !/^ses_[a-f0-9]{32}$/.test(session.sessionId || "")
    || !/^run_[a-f0-9]{32}$/.test(session.runId || "")
    || !/^[a-f0-9]{64}$/.test(session.challengeDigest || "")
    || session.teamId !== expectedTeamId
    || session.status !== "open"
    || !Number.isSafeInteger(session.submissionCount) || session.submissionCount < 0
    || !Number.isSafeInteger(session.maxSubmissions) || session.maxSubmissions < 1
    || session.submissionCount > session.maxSubmissions
    || !rankedIsoTimestampIsValid(session.createdAt)
    || !rankedIsoTimestampIsValid(session.expiresAt)
    || Date.parse(session.expiresAt) <= Date.parse(session.createdAt)
    || Date.parse(session.expiresAt) <= Date.now()
    || !competitionBatchHasExactKeys(session.challenge, expectedChallengeKeys)
    || session.challenge?.taskId !== GUANGYANG_RUNTIME_CONFIG?.taskId
    || session.challenge?.taskVersion !== GUANGYANG_RUNTIME_CONFIG?.taskVersion
    || session.challenge?.mapId !== GUANGYANG_RUNTIME_CONFIG?.mapId
    || session.challenge?.mapVersion !== GUANGYANG_RUNTIME_CONFIG?.mapVersion
    || session.challenge?.ruleVersion !== GUANGYANG_RUNTIME_CONFIG?.ruleVersion
    || session.challenge?.mapId !== lease.layout.mapId
    || session.challenge?.mapVersion !== lease.layout.mapVersion
    || !competitionBatchHasExactKeys(runDefinition, expectedRunDefinitionKeys)
    || simulationDefinition?.schemaVersion !== "chenlong.simulation/v1"
    || typeof simulationDefinition.stepMs !== "number" || !Number.isFinite(simulationDefinition.stepMs)
    || simulationDefinition.stepMs <= 0
    || interactionDefinition?.schemaVersion !== "chenlong.package-interaction/v2"
    || taskDefinition?.schemaVersion !== "chenlong.task/v5"
    || taskDefinition.id !== session.challenge.taskId
    || taskDefinition.version !== session.challenge.taskVersion
    || !Number.isSafeInteger(runDefinition.timeLimitTicks) || runDefinition.timeLimitTicks < 1
    || typeof session.challenge.timeLimitSeconds !== "number"
    || !Number.isFinite(session.challenge.timeLimitSeconds)
    || session.challenge.timeLimitSeconds <= 0
    || runDefinition.timeLimitTicks * simulationDefinition.stepMs
      !== session.challenge.timeLimitSeconds * 1000
    || !Array.isArray(packages) || packages.length !== 3
    || new Set(packages.map(item => item?.role)).size !== 3
    || packages.some(item => !item || typeof item !== "object" || Array.isArray(item)
      || !competitionBatchHasExactKeys(item, expectedPackageKeys)
      || typeof item.id !== "string" || !item.id
      || !["target", "distractor", "obstacle"].includes(item.role)
      || typeof item.x !== "number" || !Number.isFinite(item.x)
      || typeof item.z !== "number" || !Number.isFinite(item.z)
      || !Number.isSafeInteger(item.stackLevel) || item.stackLevel < 0
      || typeof item.radius !== "number" || !Number.isFinite(item.radius) || item.radius <= 0)
    || new Set(packages.map(item => item.id)).size !== packages.length) {
    throw new Error("筛选五局当前局租约不兼容");
  }
  return { envelope, lease };
}

function setCompetitionBatchStatus(status, message) {
  if (!competitionBatchStatus) return;
  competitionBatchStatus.dataset.status = status;
  competitionBatchStatus.textContent = message;
  competitionBatchStatus.title = message;
}

function setCompetitionBatchSourceLock(locked) {
  const fiveRunUiEnabled = typeof FIVE_RUN_EVALUATION_UI_ENABLED === "undefined"
    || FIVE_RUN_EVALUATION_UI_ENABLED;
  const rankedLocksSource = typeof rankedEvaluationLocksWorkspace === "function"
    ? rankedEvaluationLocksWorkspace()
    : typeof rankedEvaluationIsOpen === "function" && rankedEvaluationIsOpen();
  const active = fiveRunUiEnabled && (Boolean(locked) || rankedLocksSource);
  if (pythonEditor) {
    pythonEditor.readOnly = active;
    pythonEditor.setAttribute("aria-readonly", String(active));
    pythonEditor.classList.toggle("is-batch-locked", active);
  }
  if (competitionBatchSourceState) {
    competitionBatchSourceState.dataset.locked = String(active);
    competitionBatchSourceState.textContent = active ? "源码已锁定" : "源码未锁定";
  }
  if (loadExampleButton) loadExampleButton.disabled = active;
  if (guangyangTrainingButton) guangyangTrainingButton.disabled = active;
  if (exitGuangyangTrainingButton) exitGuangyangTrainingButton.disabled = active;
  const sceneSelect = document.querySelector("#sceneSelect");
  if (sceneSelect) sceneSelect.disabled = active;
  if (competitionTeamIdInput) competitionTeamIdInput.disabled = active || running;
  if (runButton) runButton.disabled = active || !pythonReady;
}

function setRankedEvaluationStatus(status, message) {
  if (!rankedEvaluationStatus) return;
  const deadline = activeRankedEvaluation?.expiresAt;
  const displayMessage = rankedIsoTimestampIsValid(deadline) && !String(message).includes("服务器截止")
    ? `${message} · 服务器截止 ${rankedEvaluationDisplayTime(deadline)}`
    : message;
  rankedEvaluationStatus.dataset.status = status;
  rankedEvaluationStatus.textContent = displayMessage;
}

function renderRankedEvaluationPanel() {
  if (!rankedEvaluationPanel) return;
  const active = activeRankedEvaluation;
  const batch = active?.batch || null;
  const open = rankedEvaluationIsOpen(batch);
  const finalized = batch?.phase === "finalized";
  const state = active?.uiState
    || (rankedEvaluationRestorePending
      ? "checking"
      : rankedEvaluationReservationIncomplete ? "interrupted" : rankedEvaluationReady ? "available" : "error");
  const workspaceActive = rankedEvaluationLocksWorkspace();
  rankedEvaluationPanel.dataset.state = state;
  if (competitionHud) competitionHud.dataset.rankedActive = String(workspaceActive);
  document.body?.classList.toggle("is-ranked-evaluation-active", workspaceActive);
  if (rankedEvaluationOpportunity) {
    rankedEvaluationOpportunity.textContent = active ? "已使用" : "1 次可用";
  }
  if (rankedEvaluationProgress) {
    rankedEvaluationProgress.textContent = batch ? `${batch.summary.finalizedCount} / 5` : "0 / 5";
  }
  if (rankedEvaluationScore) {
    rankedEvaluationScore.textContent = batch
      ? competitionBatchScoreText(active?.result?.score?.value ?? batch.summary.batchScore)
      : `— / ${COMPETITION_SCORE_MAXIMUM}`;
  }
  if (rankedEvaluationDeadline) {
    rankedEvaluationDeadline.textContent = rankedIsoTimestampIsValid(active?.expiresAt)
      ? rankedEvaluationDisplayTime(active.expiresAt)
      : "—";
  }
  if (startRankedEvaluationButton) {
    startRankedEvaluationButton.hidden = Boolean(active);
    startRankedEvaluationButton.disabled = !rankedEvaluationReady || !pythonReady || rankedEvaluationRestorePending
      || Boolean(rankedEvaluationOperation) || running || competitionRunStartPending
      || competitionBatchIsOpen() || Boolean(active);
    const label = startRankedEvaluationButton.querySelector("span");
    if (label) label.textContent = rankedEvaluationReady
      ? rankedEvaluationReservationIncomplete ? "重新二次确认创建" : "使用唯一一次筛选机会"
      : rankedEvaluationRestorePending ? "正在读取筛选状态" : "筛选状态暂不可用";
  }
  if (recoverRankedEvaluationButton) {
    recoverRankedEvaluationButton.hidden = !active;
    recoverRankedEvaluationButton.disabled = Boolean(rankedEvaluationOperation)
      || !pythonReady || running || competitionRunStartPending || Boolean(active?.fatal);
    const label = recoverRankedEvaluationButton.querySelector("span");
    if (label) label.textContent = rankedEvaluationOperation
      ? "筛选五局运行中"
      : open ? "恢复并继续筛选" : "恢复本次筛选源码";
  }
  if (stopRankedEvaluationButton) {
    stopRankedEvaluationButton.hidden = !open;
    stopRankedEvaluationButton.disabled = Boolean(active?.uiState === "finalizing")
      || Boolean(active?.uiState === "closing");
  }
  if (!active && !rankedEvaluationRestorePending && rankedEvaluationReady
    && !rankedEvaluationReservationIncomplete) {
    setRankedEvaluationStatus("idle", "本赛季筛选机会尚未使用；创建前会再次确认，不会误触占用。");
  } else if (finalized && active?.result) {
    const settled = batch.finalizationReason === "all_slots_reported" ? "五局已完成" : "已结算（含 0 分局）";
    setRankedEvaluationStatus(
      "success",
      `${settled} · 第 ${active.result.rank} 名 · ${competitionBatchScoreText(active.result.score.value)} · authoritative: false`
    );
  } else if (open && state === "recovery") {
    setRankedEvaluationStatus(
      "idle",
      `已恢复唯一一次筛选的第 ${batch.nextSlotIndex} / 5 局；页面不会自动运行，请明确点击“恢复并继续筛选”。`
    );
  }
  setCompetitionBatchSourceLock(competitionBatchIsOpen());
  renderCompetitionBatchPanel();
}

function competitionBatchDisplayTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(time));
}

function rankedEvaluationDisplayTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(time));
}

function renderCompetitionBatchDiscovery() {
  if (!competitionBatchRecoveryPanel || !competitionBatchRecoveryItems) return;
  const candidates = competitionBatchDiscoveryCandidates.slice(0, COMPETITION_BATCH_DISCOVERY_LIMIT);
  competitionBatchRecoveryPanel.hidden = candidates.length === 0;
  if (competitionBatchRecoveryCount) competitionBatchRecoveryCount.textContent = `${candidates.length} 项`;
  competitionBatchRecoveryItems.replaceChildren();
  candidates.forEach((candidate, index) => {
    const item = document.createElement("article");
    item.className = "competition-batch-recovery-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `未完成练习 ${index + 1}`;
    const detail = document.createElement("small");
    detail.textContent = `${candidate.sourceMatches ? "与当前源码匹配" : "与当前源码不同"}`
      + ` · 第 ${candidate.nextSlotIndex} / ${COMPETITION_BATCH_SLOT_COUNT} 局`
      + ` · ${competitionBatchDisplayTime(candidate.createdAt)}`;
    copy.append(title, detail);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.candidateIndex = String(index);
    button.dataset.action = candidate.sourceMatches ? "recover" : "close";
    button.textContent = candidate.sourceMatches ? "恢复练习" : "关闭遗失练习";
    button.disabled = competitionBatchDiscoveryInFlight
      || Boolean(activeCompetitionBatch) || Boolean(competitionBatchCreateOutcomeUnknown)
      || (typeof rankedEvaluationLocksWorkspace === "function" && rankedEvaluationLocksWorkspace());
    item.append(copy, button);
    competitionBatchRecoveryItems.append(item);
  });
}

function renderCompetitionBatchPanel() {
  if (!competitionBatchPanel) return;
  const state = activeCompetitionBatch?.uiState
    || (competitionBatchDiscoveryInFlight
      ? "discovering"
      : competitionBatchCreateOutcomeUnknown || competitionBatchDiscoveryRequired
        ? "uncertain"
        : competitionBatchDiscoveryCandidates.some(candidate => candidate.sourceMatches)
          ? "discovered"
          : "idle");
  const batch = activeCompetitionBatch?.batch || null;
  const open = competitionBatchIsOpen(batch);
  const actionableOpen = open && !activeCompetitionBatch?.fatal;
  const finalized = batch?.phase === "finalized";
  const slotIndex = finalized
    ? activeCompetitionBatch?.lastSlotIndex || COMPETITION_BATCH_SLOT_COUNT
    : open ? batch.nextSlotIndex : null;
  competitionBatchPanel.dataset.state = state;
  if (competitionHud) competitionHud.dataset.batchActive = String(actionableOpen);
  setCompetitionBatchSourceLock(actionableOpen || state === "creating" || Boolean(competitionBatchCreateOutcomeUnknown));
  if (competitionBatchSlot) {
    competitionBatchSlot.textContent = slotIndex ? `第 ${slotIndex} / ${COMPETITION_BATCH_SLOT_COUNT} 局` : "未开始";
  }
  const stateLabels = {
    idle: "等待锁定源码",
    discovering: "正在查找未完成练习",
    discovered: "发现未完成练习",
    uncertain: "正在确认创建结果",
    creating: "正在创建练习",
    leasing: "正在准备当前局",
    recovery: "等待继续",
    running: "自动运行中",
    finalizing: "正在验证本局",
    closing: "正在停止练习",
    finalized: "练习五局完成",
    error: "需要重试"
  };
  if (competitionBatchState) competitionBatchState.textContent = stateLabels[state] || "状态未知";

  let currentScore = activeCompetitionBatch?.currentScore;
  if (finalized) currentScore = batch.slots[(slotIndex || COMPETITION_BATCH_SLOT_COUNT) - 1]?.score;
  if (competitionBatchCurrentScore) {
    competitionBatchCurrentScore.textContent = competitionBatchScoreText(currentScore, 1);
  }
  const showSummary = finalized;
  if (competitionBatchMeanScore) {
    competitionBatchMeanScore.textContent = showSummary
      ? competitionBatchScoreText(batch.summary.meanScore)
      : `— / ${COMPETITION_SCORE_MAXIMUM}`;
  }
  if (competitionBatchMinimumScore) {
    competitionBatchMinimumScore.textContent = showSummary
      ? competitionBatchScoreText(batch.summary.minScore)
      : `— / ${COMPETITION_SCORE_MAXIMUM}`;
  }
  if (competitionBatchScore) {
    competitionBatchScore.textContent = showSummary
      ? competitionBatchScoreText(batch.summary.batchScore)
      : `— / ${COMPETITION_SCORE_MAXIMUM}`;
  }

  const mayStart = !actionableOpen || state === "recovery" || state === "error";
  if (startCompetitionBatchButton) {
    startCompetitionBatchButton.hidden = !mayStart;
    startCompetitionBatchButton.disabled = Boolean(competitionBatchOperation)
      || competitionBatchRestorePending
      || (typeof rankedEvaluationLocksWorkspace === "function" && rankedEvaluationLocksWorkspace())
      || ["creating", "discovering", "discovered", "leasing", "running", "finalizing", "closing"].includes(state)
      || running || competitionRunStartPending || !pythonReady;
    const label = startCompetitionBatchButton.querySelector("span");
    if (label) {
      let labelText = finalized ? "开始新的练习五局" : "锁定源码并自动练习 5 局";
      if (state === "recovery") labelText = "继续当前练习五局";
      else if (state === "uncertain") {
        labelText = competitionBatchCreateOutcomeUnknown
          ? "使用原源码安全重试创建"
          : "重新查找未完成练习";
      }
      else if (state === "discovered") labelText = "请先恢复匹配练习";
      else if (state === "error" && actionableOpen) labelText = "重试并继续当前练习";
      label.textContent = labelText;
    }
  }
  if (stopCompetitionBatchButton) {
    stopCompetitionBatchButton.hidden = !actionableOpen;
    stopCompetitionBatchButton.disabled = ["creating", "finalizing", "closing"].includes(state);
  }
  renderCompetitionBatchDiscovery();
}

function persistCompetitionBatchPendingCreate(pendingCreate) {
  if (!pendingCreate || typeof pendingCreate.source !== "string"
    || !pendingCreate.source.trim() || pendingCreate.source.length > MAX_PYTHON_DRAFT_LENGTH
    || !/^[a-f0-9]{64}$/.test(pendingCreate.sourceDigest || "")) return false;
  let teamId;
  try {
    teamId = normalizeCompetitionBatchTeamId(pendingCreate.teamId);
  } catch (_error) {
    return false;
  }
  try {
    sessionStorage.setItem(COMPETITION_BATCH_RECOVERY_STORAGE_KEY, JSON.stringify({
      schemaVersion: "chenlong.batch-browser-recovery/v1",
      pendingCreate: {
        source: pendingCreate.source,
        teamId,
        sourceDigest: pendingCreate.sourceDigest
      }
    }));
    return true;
  } catch (_error) {
    return false;
  }
}

function clearCompetitionBatchRecoveryStorage() {
  try { sessionStorage.removeItem(COMPETITION_BATCH_RECOVERY_STORAGE_KEY); } catch (_error) {}
}

function persistCompetitionBatchRecovery() {
  try {
    if (competitionBatchCreateOutcomeUnknown) {
      persistCompetitionBatchPendingCreate(competitionBatchCreateOutcomeUnknown);
      return;
    }
    if (!competitionBatchIsOpen() || !activeCompetitionBatch?.source) {
      clearCompetitionBatchRecoveryStorage();
      return;
    }
    sessionStorage.setItem(COMPETITION_BATCH_RECOVERY_STORAGE_KEY, JSON.stringify({
      schemaVersion: "chenlong.batch-browser-recovery/v1",
      batchId: activeCompetitionBatch.batch.batchId,
      source: activeCompetitionBatch.source,
      teamId: activeCompetitionBatch.teamId,
      probeBoundTeamFirst: Boolean(activeCompetitionBatch.probeBoundTeamFirst)
    }));
  } catch (_error) {
    // Storage may be disabled; the running in-memory batch remains valid.
  }
}

function readCompetitionBatchRecovery() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(COMPETITION_BATCH_RECOVERY_STORAGE_KEY) || "null");
    if (!parsed || parsed.schemaVersion !== "chenlong.batch-browser-recovery/v1") return null;
    if (parsed.pendingCreate !== undefined) {
      const pendingCreate = parsed.pendingCreate;
      if (!competitionBatchHasExactKeys(parsed, ["schemaVersion", "pendingCreate"])
        || !competitionBatchHasExactKeys(pendingCreate, ["source", "teamId", "sourceDigest"])
        || typeof pendingCreate.source !== "string" || !pendingCreate.source.trim()
        || pendingCreate.source.length > MAX_PYTHON_DRAFT_LENGTH
        || !/^[a-f0-9]{64}$/.test(pendingCreate.sourceDigest || "")
        || typeof pendingCreate.teamId !== "string") return null;
      return {
        kind: "pending-create",
        source: pendingCreate.source,
        teamId: normalizeCompetitionBatchTeamId(pendingCreate.teamId),
        sourceDigest: pendingCreate.sourceDigest
      };
    }
    const recoveryKeys = parsed.probeBoundTeamFirst === undefined
      ? ["schemaVersion", "batchId", "source", "teamId"]
      : ["schemaVersion", "batchId", "source", "teamId", "probeBoundTeamFirst"];
    if (!competitionBatchHasExactKeys(parsed, recoveryKeys)
      || !/^bat_[a-f0-9]{32}$/.test(parsed.batchId || "")
      || typeof parsed.source !== "string" || !parsed.source.trim()
      || parsed.source.length > MAX_PYTHON_DRAFT_LENGTH
      || typeof parsed.teamId !== "string"
      || (parsed.probeBoundTeamFirst !== undefined && typeof parsed.probeBoundTeamFirst !== "boolean")) return null;
    return {
      kind: "batch",
      batchId: parsed.batchId,
      source: parsed.source,
      teamId: normalizeCompetitionBatchTeamId(parsed.teamId),
      probeBoundTeamFirst: parsed.probeBoundTeamFirst === true
    };
  } catch (_error) {
    return null;
  }
}

async function requestCompetitionBatch(endpoint, options = {}, signal = null) {
  const { response, payload } = await requestVerificationEndpoint(
    endpoint,
    options,
    RUN_RECORD_VERIFICATION_TIMEOUT_MS,
    signal
  );
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `练习五局请求失败（HTTP ${response.status}）`);
    error.code = String(payload?.error?.code || "BATCH_REQUEST_FAILED");
    error.status = response.status;
    throw error;
  }
  setVerificationServiceHealth("online");
  return normalizeCompetitionBatchEnvelope(payload);
}

function rankedEvaluationErrorMessage(error, fallback = "筛选五局暂时无法继续") {
  const messages = {
    RANKED_ATTEMPT_RESERVATION_INCOMPLETE: "创建中断，请用原源码和原队伍重新二次确认。",
    RANKED_ATTEMPT_ALREADY_EXISTS: "本赛季唯一一次筛选已由另一份源码或队伍创建，不能换卷重来。",
    RANKED_TEAM_LOCKED: "筛选队伍已锁定，不能更换。",
    SOURCE_LOCKED: "运行记录与本赛季锁定源码不一致。",
    BATCH_EXPIRED: "筛选五局已过期，未完成局已按 0 分结算。",
    BATCH_FINALIZED: "筛选五局已经结算，不能继续运行。",
    BATCH_NOT_FOUND: "本赛季筛选记录暂时无法读取。",
    BATCH_OWNER_MISMATCH: "该筛选不属于当前登录账号。",
    SLOT_NOT_CURRENT: "当前局已变化，请重新读取筛选进度。",
    SLOT_ALREADY_FINALIZED: "本局已经结算，请重新读取最新进度。",
    SLOT_SESSION_MISMATCH: "本局记录与锁定场次不一致，尚未推进。",
    SESSION_LIMIT_REACHED: "当前可运行场次数已满，请稍后恢复筛选。",
    SESSION_SCOPE_LIMIT_REACHED: "当前筛选运行名额已满，请稍后重试；不会额外占用机会。",
    SESSION_ARCHIVE_FULL: "筛选存档空间已满，请联系管理员。",
    ARCHIVE_STORAGE_FULL: "筛选存档空间已满，请联系管理员。",
    BATCH_LIMIT_REACHED: "筛选服务的运行名额已满，请稍后恢复。",
    BATCH_STORAGE_FULL: "筛选记录空间已满，请联系管理员。",
    BATCH_ARCHIVE_FULL: "筛选记录数量已达上限，请联系管理员。",
    SUBMISSION_DEADLINE_EXPIRED: "已过服务器截止，未写入本局。",
    RANKED_SUBMISSION_OUTSIDE_WINDOW: "已过服务器截止，未写入本局。",
    BATCH_RECEIPT_EVIDENCE_CORRUPTED: "归档证据异常，已停止发布/推进，请管理员处理。",
    BATCH_FINALIZATION_EVIDENCE_CONFLICT: "归档证据异常，已停止发布/推进，请管理员处理。",
    AUTHENTICATION_REQUIRED: "登录状态已失效，请重新登录后继续。"
  };
  const code = String(error?.code || "");
  if (messages[code]) return messages[code];
  return String(error?.message || fallback).trim().slice(0, 160) || fallback;
}

async function requestRankedEvaluation(endpoint, options, kind, signal = null) {
  const { response, payload } = await requestVerificationEndpoint(
    endpoint,
    options,
    RUN_RECORD_VERIFICATION_TIMEOUT_MS,
    signal
  );
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `筛选五局请求失败（HTTP ${response.status}）`);
    error.code = String(payload?.error?.code || "RANKED_REQUEST_FAILED");
    error.status = response.status;
    throw error;
  }
  setVerificationServiceHealth("online");
  return normalizeRankedEvaluationResponse(payload, kind);
}

async function requestCompetitionBatchOpenList(signal = null) {
  const { response, payload } = await requestVerificationEndpoint(
    `${COMPETITION_BATCH_ENDPOINT}?phase=open`,
    { method: "GET" },
    RUN_RECORD_VERIFICATION_TIMEOUT_MS,
    signal
  );
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `未完成练习查询失败（HTTP ${response.status}）`);
    error.code = String(payload?.error?.code || "BATCH_DISCOVERY_FAILED");
    error.status = response.status;
    throw error;
  }
  setVerificationServiceHealth("online");
  return normalizeCompetitionBatchOpenList(payload);
}

async function competitionBatchSourceDigest(source) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder !== "function") {
    throw new Error("当前浏览器无法校验锁定源码");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function discoverOpenCompetitionBatches(options = {}) {
  if (competitionBatchDiscoveryInFlight || activeCompetitionBatch) {
    return { ok: false, candidates: competitionBatchDiscoveryCandidates };
  }
  const source = typeof options.source === "string"
    ? options.source.trim()
    : String(pythonEditor?.value || "").trim();
  const knownDigest = /^[a-f0-9]{64}$/.test(options.sourceDigest || "")
    ? options.sourceDigest
    : "";
  competitionBatchDiscoveryInFlight = true;
  if (options.required !== false) competitionBatchDiscoveryRequired = true;
  setCompetitionBatchStatus(
    "checking",
    competitionBatchCreateOutcomeUnknown
      ? "上次练习创建结果尚未确认，正在查找同一源码的未完成练习；确认前不会再次创建。"
      : "正在查找当前账号的未完成练习；不会自动领取或运行任何一局。"
  );
  renderCompetitionBatchPanel();
  try {
    const payload = await requestCompetitionBatchOpenList();
    const digest = knownDigest || (source ? await competitionBatchSourceDigest(source) : "");
    competitionBatchDiscoveryCandidates = payload.batches.map(item => ({
      ...item,
      sourceMatches: Boolean(digest && item.sourceDigest === digest)
    }));
    const matching = competitionBatchDiscoveryCandidates.filter(candidate => candidate.sourceMatches);
    competitionBatchDiscoveryRequired = false;
    if (competitionBatchCreateOutcomeUnknown) {
      if (matching.length === 0) {
        setCompetitionBatchStatus(
          "error",
          "列表暂未显示与原源码匹配的练习，但上次创建结果仍无法确认。请点击“使用原源码安全重试创建”；源码保持锁定。"
        );
      } else if (matching.length === 1) {
        setCompetitionBatchStatus(
          "idle",
          "已看到与原源码匹配的未完成练习。请点击“使用原源码安全重试创建”，由服务端安全复用；页面不会自动运行。"
        );
      } else {
        setCompetitionBatchStatus(
          "error",
          "发现多个与原源码相同的未完成练习。源码继续锁定，请点击“使用原源码安全重试创建”完成服务端确认。"
        );
      }
    } else if (matching.length === 1) {
      setCompetitionBatchStatus(
        "idle",
        "发现与当前源码匹配的未完成练习。请选择“恢复练习”；页面不会自动领取或运行。"
      );
    } else if (matching.length > 1) {
      setCompetitionBatchStatus(
        "idle",
        "发现多个与当前源码相同的未完成练习，请明确选择一个恢复；页面不会猜选或自动运行。"
      );
    } else if (competitionBatchDiscoveryCandidates.length > 0) {
      setCompetitionBatchStatus(
        "idle",
        "发现与当前源码不同的未完成练习；如不再需要，可逐个确认关闭以释放未完成名额。"
      );
    } else {
      setCompetitionBatchStatus("idle", "未发现未完成练习；可以锁定当前源码开始练习五局（不入榜）。");
    }
    return { ok: true, candidates: competitionBatchDiscoveryCandidates, matching };
  } catch (error) {
    competitionBatchDiscoveryRequired = true;
    const message = competitionBatchErrorMessage(error, "暂时无法查找未完成练习");
    setCompetitionBatchStatus(
      "error",
      competitionBatchCreateOutcomeUnknown
        ? `${message}。请点击“使用原源码安全重试创建”；源码保持锁定。`
        : `${message}。请点击“重新查找未完成练习”；确认前不会新建练习。`
    );
    return { ok: false, candidates: competitionBatchDiscoveryCandidates, error };
  } finally {
    competitionBatchDiscoveryInFlight = false;
    renderCompetitionBatchPanel();
  }
}

async function refreshCompetitionBatchDiscoveryDraftMatch() {
  if (activeCompetitionBatch || competitionBatchDiscoveryCandidates.length === 0) return;
  const source = String(pythonEditor?.value || "").trim();
  if (!source) {
    competitionBatchDiscoveryCandidates.forEach(candidate => { candidate.sourceMatches = false; });
    renderCompetitionBatchPanel();
    return;
  }
  try {
    const digest = await competitionBatchSourceDigest(source);
    if (source !== String(pythonEditor?.value || "").trim() || activeCompetitionBatch) return;
    competitionBatchDiscoveryCandidates.forEach(candidate => {
      candidate.sourceMatches = candidate.sourceDigest === digest;
    });
    renderCompetitionBatchPanel();
  } catch (_error) {
    // Creation performs the same digest check and remains fail-closed.
  }
}

async function recoverDiscoveredCompetitionBatch(candidateIndex) {
  if (competitionBatchDiscoveryInFlight || competitionBatchCreateOutcomeUnknown
    || activeCompetitionBatch || competitionBatchOperation) return;
  const candidate = competitionBatchDiscoveryCandidates[candidateIndex];
  if (!candidate) return;
  const source = String(pythonEditor?.value || "").trim();
  if (!source) {
    setCompetitionBatchStatus("error", "当前源码为空，无法确认要恢复的练习。");
    return;
  }
  let teamId;
  try {
    teamId = normalizeCompetitionBatchTeamId(currentCompetitionTeamId());
  } catch (error) {
    setCompetitionBatchStatus("error", competitionBatchErrorMessage(error));
    competitionTeamIdInput?.focus?.();
    return;
  }
  competitionBatchDiscoveryInFlight = true;
  renderCompetitionBatchPanel();
  try {
    const digest = await competitionBatchSourceDigest(source);
    if (digest !== candidate.sourceDigest) {
      candidate.sourceMatches = false;
      setCompetitionBatchStatus(
        "error",
        "当前源码已变化，与这个未完成练习不一致；不会覆盖或继续该练习。"
      );
      return;
    }
    const envelope = await requestCompetitionBatch(
      `${COMPETITION_BATCH_ENDPOINT}/${encodeURIComponent(candidate.batchId)}`,
      { method: "GET" }
    );
    if (envelope.batch.phase !== "open" || envelope.batch.sourceDigest !== digest) {
      throw new Error("这个练习已结束或与当前源码不一致");
    }
    if (activeMission?.environment !== "guangyang" || activeMission?.objectTraining) {
      loadMission("guangyang", { batchInternal: true });
    }
    activeCompetitionBatch = {
      source,
      teamId,
      batch: envelope.batch,
      currentSlot: envelope.currentSlot,
      lease: null,
      pendingRecord: null,
      currentScore: null,
      lastSlotIndex: envelope.batch.nextSlotIndex,
      uiState: "recovery",
      restoredFromPage: true,
      probeBoundTeamFirst: true,
      stopBatchRequested: false,
      fatal: false
    };
    competitionBatchDiscoveryCandidates = [];
    competitionBatchDiscoveryRequired = false;
    competitionBatchCreateOutcomeUnknown = null;
    pythonEditor.value = source;
    updateLineNumbers();
    renderPythonHighlight();
    persistPythonDraft();
    persistCompetitionBatchRecovery();
    setCompetitionBatchStatus(
      "idle",
      `已恢复练习第 ${envelope.batch.nextSlotIndex} / ${COMPETITION_BATCH_SLOT_COUNT} 局；请点击“继续当前练习五局”，页面不会自动领取或运行。`
    );
  } catch (error) {
    setCompetitionBatchStatus("error", `恢复失败：${competitionBatchErrorMessage(error)}。`);
  } finally {
    competitionBatchDiscoveryInFlight = false;
    renderCompetitionBatchPanel();
  }
}

async function closeDiscoveredCompetitionBatch(candidateIndex) {
  if (competitionBatchDiscoveryInFlight || competitionBatchCreateOutcomeUnknown
    || activeCompetitionBatch || competitionBatchOperation) return;
  const candidate = competitionBatchDiscoveryCandidates[candidateIndex];
  if (!candidate) return;
  const confirmed = window.confirm(
    "确定关闭这个遗失的练习五局吗？未完成局会按 missing / 0 分结算；此操作不会返还一次练习机会。"
  );
  if (!confirmed) return;
  competitionBatchDiscoveryInFlight = true;
  setCompetitionBatchStatus("checking", "正在关闭所选未完成练习；其他练习不会受影响。");
  renderCompetitionBatchPanel();
  try {
    await requestCompetitionBatch(
      `${COMPETITION_BATCH_ENDPOINT}/${encodeURIComponent(candidate.batchId)}/close`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }
    );
    competitionBatchDiscoveryCandidates = competitionBatchDiscoveryCandidates
      .filter(item => item.batchId !== candidate.batchId);
    setCompetitionBatchStatus(
      "success",
      "所选练习已关闭，未完成名额已经释放；该练习仍计入 20 次练习机会，且不入榜。"
    );
  } catch (error) {
    setCompetitionBatchStatus("error", `关闭失败：${competitionBatchErrorMessage(error)}。`);
  } finally {
    competitionBatchDiscoveryInFlight = false;
    renderCompetitionBatchPanel();
  }
  if (!activeCompetitionBatch) {
    await discoverOpenCompetitionBatches({ source: String(pythonEditor?.value || ""), required: true });
  }
}

function applyCompetitionBatchLeaseScene(lease) {
  const packages = lease?.runDefinition?.interactionDefinition?.packages;
  if (!Array.isArray(packages) || packages.length !== 3) {
    throw new Error("当前局缺少场景对象定义");
  }
  if (activeMission?.environment !== "guangyang" || activeMission?.objectTraining) {
    loadMission("guangyang", { batchInternal: true });
  }
  const mission = structuredClone(missions.guangyang);
  const metadataByRole = new Map(GUANGYANG_OBJECT_TASK.objects.map(item => [item.role, item]));
  mission.packages = packages
    .filter(item => item.role === "target" || item.role === "distractor")
    .map(item => {
      const metadata = metadataByRole.get(item.role) || {};
      return {
        id: item.id,
        x: Number(item.x),
        z: Number(item.z),
        role: item.role,
        category: metadata.category || (item.role === "distractor" ? "混淆物" : "目标物"),
        color: metadata.color || (item.role === "distractor" ? "#3b82f6" : "#ef4444"),
        radius: Number(item.radius)
      };
    });
  mission.objectObstacles = packages
    .filter(item => item.role === "obstacle")
    .map(item => {
      const metadata = metadataByRole.get("obstacle") || {};
      return {
        id: item.id,
        x: Number(item.x),
        z: Number(item.z),
        role: "obstacle",
        category: metadata.category || "障碍物",
        color: metadata.color || "#facc15",
        radius: Number(item.radius)
      };
    });
  const initialPose = lease.runDefinition.simulationDefinition?.initialPose;
  if (initialPose && [initialPose.x, initialPose.z, initialPose.heading].every(Number.isFinite)) {
    mission.start = [initialPose.x, initialPose.z, initialPose.heading];
  }
  activeMission = mission;
  activeMission.packages = normalizePackageRecords(activeMission);
  renderMissionInfo();
  captureMissionBaseline();
  invalidateDeterministicSimulator();
}

async function leaseCurrentCompetitionBatchSlot() {
  const batch = activeCompetitionBatch?.batch;
  if (!competitionBatchIsOpen(batch)) throw new Error("当前没有可运行的练习五局");
  const batchId = batch.batchId;
  const slotIndex = batch.nextSlotIndex;
  const teamId = activeCompetitionBatch.teamId || currentCompetitionTeamId();
  activeCompetitionBatch.uiState = "leasing";
  activeCompetitionBatch.currentScore = null;
  setCompetitionBatchStatus("checking", `正在准备第 ${slotIndex} / ${COMPETITION_BATCH_SLOT_COUNT} 局；未来局尚未下发。`);
  renderCompetitionBatchPanel();
  const requestLease = body => requestVerificationEndpoint(
    `${COMPETITION_BATCH_ENDPOINT}/${encodeURIComponent(batchId)}/current-slot/lease`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    },
    RUN_RECORD_VERIFICATION_TIMEOUT_MS
  );
  let body = activeCompetitionBatch.probeBoundTeamFirst ? { slotIndex } : { slotIndex, teamId };
  let { response, payload } = await requestLease(body);
  if (!response.ok && activeCompetitionBatch.probeBoundTeamFirst
    && payload?.error?.code === "INVALID_TEAM_ID") {
    body = { slotIndex, teamId };
    ({ response, payload } = await requestLease(body));
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `当前局准备失败（HTTP ${response.status}）`);
    error.code = String(payload?.error?.code || "BATCH_LEASE_FAILED");
    error.status = response.status;
    throw error;
  }
  const { envelope, lease } = normalizeCompetitionBatchLease(
    payload,
    batchId,
    slotIndex,
    body.teamId || ""
  );
  if (envelope.batch.sourceDigest !== batch.sourceDigest) {
    throw new Error("当前局租约与锁定源码不匹配");
  }
  activeCompetitionBatch.batch = envelope.batch;
  activeCompetitionBatch.currentSlot = envelope.currentSlot;
  activeCompetitionBatch.lease = lease;
  activeCompetitionBatch.teamId = normalizeCompetitionBatchTeamId(lease.session.teamId);
  activeCompetitionBatch.probeBoundTeamFirst = false;
  activeCompetitionBatch.lastSlotIndex = slotIndex;
  activeCompetitionBatch.restoredFromPage = false;
  if (competitionTeamIdInput) competitionTeamIdInput.value = activeCompetitionBatch.teamId;
  applyCompetitionBatchLeaseScene(lease);
  persistCompetitionBatchRecovery();
  return lease;
}

async function submitCurrentCompetitionBatchSlot(record) {
  const active = activeCompetitionBatch;
  const lease = active?.lease;
  const slotIndex = lease?.slotIndex;
  if (!active || !lease || !record || !Number.isSafeInteger(slotIndex)) {
    throw new Error("当前局运行记录尚未就绪");
  }
  active.uiState = "finalizing";
  active.currentScore = Number(record.result?.score);
  active.pendingRecord = record;
  setCompetitionBatchStatus(
    "checking",
    `第 ${slotIndex} 局已结束，正在服务端重算并原子写入；确认前不会进入下一局。`
  );
  renderCompetitionBatchPanel();
  const { response, payload } = await requestVerificationEndpoint(
    `${COMPETITION_BATCH_ENDPOINT}/${encodeURIComponent(active.batch.batchId)}`
      + `/slots/${slotIndex}/sessions/${encodeURIComponent(lease.session.sessionId)}/submissions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record)
    },
    RUN_RECORD_VERIFICATION_TIMEOUT_MS
  );
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `本局验证失败（HTTP ${response.status}）`);
    error.code = String(payload?.error?.code || "BATCH_SUBMISSION_FAILED");
    error.status = response.status;
    throw error;
  }
  const envelope = normalizeCompetitionBatchEnvelope(payload);
  if (envelope.batch.sourceDigest !== active.batch.sourceDigest) {
    throw new Error("本局验证响应与锁定源码不匹配");
  }
  const finalizedSlot = envelope.batch.slots[slotIndex - 1];
  if (!finalizedSlot?.final || finalizedSlot.status === "pending") {
    throw new Error("服务端未确认本局已经写入");
  }
  active.batch = envelope.batch;
  active.currentSlot = envelope.currentSlot;
  active.pendingRecord = null;
  active.lease = null;
  active.currentScore = finalizedSlot.score;
  persistCompetitionBatchRecovery();
  return envelope;
}

async function closeActiveCompetitionBatch() {
  const active = activeCompetitionBatch;
  if (!competitionBatchIsOpen(active?.batch)) return active?.batch || null;
  active.uiState = "closing";
  setCompetitionBatchStatus("checking", "正在停止练习；当前及其余未完成局将按 missing / 0 分计入。 ");
  renderCompetitionBatchPanel();
  const envelope = await requestCompetitionBatch(
    `${COMPETITION_BATCH_ENDPOINT}/${encodeURIComponent(active.batch.batchId)}/close`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }
  );
  active.batch = envelope.batch;
  active.currentSlot = null;
  active.lease = null;
  active.pendingRecord = null;
  active.uiState = "finalized";
  active.stopBatchRequested = false;
  persistCompetitionBatchRecovery();
  setCompetitionBatchStatus("success", "练习已停止；未完成局已按 0 分计入最终汇总，结果不入榜。");
  renderCompetitionBatchPanel();
  return active.batch;
}

function finishCompetitionBatchUi(message = "练习五局均已完成，最终分数来自服务端公开汇总，结果不入榜。") {
  if (!activeCompetitionBatch) return;
  activeCompetitionBatch.uiState = "finalized";
  activeCompetitionBatch.lease = null;
  activeCompetitionBatch.pendingRecord = null;
  activeCompetitionBatch.stopBatchRequested = false;
  persistCompetitionBatchRecovery();
  setCompetitionBatchStatus("success", message);
  renderCompetitionBatchPanel();
  setStatus("练习五局自动运行完成（不入榜）");
  addLog("练习五局已完成；已生成本地参考的均分、最低分与 70/30 总分，不进入筛选排名。", true);
}

async function runCompetitionBatchSequence() {
  const active = activeCompetitionBatch;
  if (!competitionBatchIsOpen(active?.batch)) return;
  try {
    while (active === activeCompetitionBatch && competitionBatchIsOpen(active.batch)) {
      if (active.stopBatchRequested) {
        await closeActiveCompetitionBatch();
        return;
      }
      if (active.pendingRecord && active.lease) {
        await submitCurrentCompetitionBatchSlot(active.pendingRecord);
      } else {
        const lease = active.lease || await leaseCurrentCompetitionBatchSlot();
        if (active.stopBatchRequested) {
          await closeActiveCompetitionBatch();
          return;
        }
        active.uiState = "running";
        active.currentScore = null;
        setCompetitionBatchStatus(
          "checking",
          `第 ${lease.slotIndex} / ${COMPETITION_BATCH_SLOT_COUNT} 局正在用已锁定源码自动运行。`
        );
        renderCompetitionBatchPanel();
        await runProgram({ batchManaged: true });
        if (active.stopBatchRequested) {
          await closeActiveCompetitionBatch();
          return;
        }
        const record = latestCompetitionRecord;
        if (!record || record.runId !== lease.session.runId
          || record.serverSessionId !== lease.session.sessionId
          || record.challengeDigest !== lease.session.challengeDigest) {
          throw new Error("本局未生成与租约匹配的运行记录");
        }
        await submitCurrentCompetitionBatchSlot(record);
      }
      if (active.batch.phase === "finalized") {
        finishCompetitionBatchUi();
        return;
      }
      active.currentScore = null;
    }
  } catch (error) {
    if (active !== activeCompetitionBatch) return;
    const code = String(error?.code || "");
    const fatal = [
      "SOURCE_LOCKED", "BATCH_EXPIRED", "BATCH_OWNER_MISMATCH", "BATCH_FINALIZED", "BATCH_NOT_FOUND"
    ].includes(code);
    active.uiState = "error";
    active.fatal = fatal;
    if (fatal) {
      active.lease = null;
      active.pendingRecord = null;
      try { sessionStorage.removeItem(COMPETITION_BATCH_RECOVERY_STORAGE_KEY); } catch (_error) {}
    }
    const message = competitionBatchErrorMessage(error);
    setCompetitionBatchStatus(
      "error",
      fatal
        ? `当前练习无法继续：${message}。请开始新的练习五局。`
        : `本局尚未推进：${message}。点击“重试并继续当前练习”可从本局恢复。`
    );
    renderCompetitionBatchPanel();
    setStatus(`练习五局暂停：${message}`);
    addLog(`练习五局暂停（不入榜）：${message}。`);
  }
}

function continueCompetitionBatch() {
  if (competitionBatchOperation || !competitionBatchIsOpen() || activeCompetitionBatch?.fatal) return;
  const operation = runCompetitionBatchSequence();
  competitionBatchOperation = operation;
  renderCompetitionBatchPanel();
  operation.finally(() => {
    if (competitionBatchOperation === operation) competitionBatchOperation = null;
    renderCompetitionBatchPanel();
  });
  return operation;
}

async function startOrContinueCompetitionBatch() {
  if (typeof rankedEvaluationLocksWorkspace === "function" && rankedEvaluationLocksWorkspace()) {
    setStatus("筛选五局已锁定源码与队伍，练习五局暂不可用");
    return;
  }
  if (competitionBatchOperation || competitionBatchDiscoveryInFlight || competitionBatchRestorePending
    || running || competitionRunStartPending) return;
  if (competitionBatchIsOpen() && !activeCompetitionBatch?.fatal) {
    activeCompetitionBatch.uiState = activeCompetitionBatch.uiState === "recovery" ? "leasing" : activeCompetitionBatch.uiState;
    setCompetitionBatchStatus("checking", "正在继续当前练习；不会创建新的场次。");
    continueCompetitionBatch();
    return;
  }
  const unknownCreateRetry = competitionBatchCreateOutcomeUnknown;
  if (!unknownCreateRetry && competitionBatchDiscoveryRequired) {
    await discoverOpenCompetitionBatches({
      source: String(pythonEditor?.value || ""),
      required: true
    });
    return;
  }
  if (!isCompetitionMission() || activeMission?.environment !== "guangyang" || activeMission?.objectTraining) {
    setStatus("请先进入广阳岛正式综合任务");
    setCompetitionBatchStatus("error", "练习五局仅用于广阳岛综合任务，结果不进入筛选排名。");
    return;
  }
  const source = unknownCreateRetry?.source ?? pythonEditor.value.trim();
  if (!source) {
    setStatus("请先写 Python 代码");
    setCompetitionBatchStatus("error", "源码为空，尚未创建练习。");
    return;
  }
  if (!pythonReady) {
    setStatus("Python 还在准备中");
    return;
  }
  let teamId;
  try {
    teamId = normalizeCompetitionBatchTeamId(
      unknownCreateRetry?.teamId ?? currentCompetitionTeamId()
    );
  } catch (error) {
    const message = String(error?.message || error);
    setStatus(message);
    setCompetitionBatchStatus("error", `${message}；尚未创建练习。`);
    competitionTeamIdInput?.focus?.();
    return;
  }
  let sourceDigest;
  try {
    sourceDigest = await competitionBatchSourceDigest(source);
    if (unknownCreateRetry && sourceDigest !== unknownCreateRetry.sourceDigest) {
      throw new Error("原锁定源码校验失败，未发送新的创建请求");
    }
  } catch (error) {
    const message = competitionBatchErrorMessage(error);
    setCompetitionBatchStatus("error", message);
    setStatus(message);
    return;
  }
  competitionBatchDiscoveryCandidates = competitionBatchDiscoveryCandidates.map(candidate => ({
    ...candidate,
    sourceMatches: candidate.sourceDigest === sourceDigest
  }));
  if (!unknownCreateRetry
    && competitionBatchDiscoveryCandidates.some(candidate => candidate.sourceMatches)) {
    setCompetitionBatchStatus(
      "idle",
      "发现与当前源码匹配的未完成练习，请先选择“恢复练习”；不会创建重复练习。"
    );
    renderCompetitionBatchPanel();
    return;
  }
  const pendingCreate = { source, teamId, sourceDigest };
  if (!persistCompetitionBatchPendingCreate(pendingCreate)) {
    setCompetitionBatchStatus(
      "error",
      "当前浏览器无法保存待确认的创建状态，因此没有发送请求。请允许当前页面使用会话存储后重试。"
    );
    renderCompetitionBatchPanel();
    return;
  }
  competitionBatchCreateOutcomeUnknown = pendingCreate;
  const requestSerial = ++competitionBatchRequestSerial;
  const abortController = new AbortController();
  competitionBatchAbortController?.abort();
  competitionBatchAbortController = abortController;
  pythonEditor.value = source;
  updateLineNumbers();
  renderPythonHighlight();
  persistPythonDraft();
  activeCompetitionBatch = {
    source,
    teamId,
    batch: null,
    currentSlot: null,
    lease: null,
    pendingRecord: null,
    currentScore: null,
    lastSlotIndex: 1,
    uiState: "creating",
    restoredFromPage: false,
    probeBoundTeamFirst: true,
    stopBatchRequested: false,
    fatal: false
  };
  setCompetitionBatchStatus(
    "checking",
    unknownCreateRetry
      ? "正在使用原锁定源码安全重试；不会改用当前编辑器中的其他源码。"
      : "正在锁定当前源码并创建练习五局（本地参考，不入榜）…"
  );
  setCompetitionBatchSourceLock(true);
  renderCompetitionBatchPanel();
  try {
    const envelope = await requestCompetitionBatch(
      COMPETITION_BATCH_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source })
      },
      abortController.signal
    );
    if (requestSerial !== competitionBatchRequestSerial) return;
    if (envelope.batch.sourceDigest !== sourceDigest) {
      throw new Error("服务端未正确锁定当前源码");
    }
    competitionBatchDiscoveryCandidates = [];
    competitionBatchDiscoveryRequired = false;
    competitionBatchCreateOutcomeUnknown = null;
    activeCompetitionBatch.batch = envelope.batch;
    activeCompetitionBatch.currentSlot = envelope.currentSlot;
    activeCompetitionBatch.uiState = "leasing";
    persistCompetitionBatchRecovery();
    setCompetitionBatchStatus("checking", "练习源码已锁定；即将自动开始第 1 / 5 局，结果不入榜。");
    renderCompetitionBatchPanel();
    continueCompetitionBatch();
  } catch (error) {
    if (requestSerial !== competitionBatchRequestSerial || error?.name === "AbortError") return;
    activeCompetitionBatch = null;
    const resultKnown = Number.isSafeInteger(error?.status)
      && error.status >= 400 && error.status < 500;
    if (!resultKnown) {
      competitionBatchCreateOutcomeUnknown = { source, teamId, sourceDigest };
      competitionBatchDiscoveryRequired = true;
      setCompetitionBatchStatus(
        "error",
        "练习创建结果尚未确认，正在查找同一源码的未完成练习；确认前不会再次创建。"
      );
      renderCompetitionBatchPanel();
      await discoverOpenCompetitionBatches({ source, sourceDigest, required: true });
    } else {
      competitionBatchCreateOutcomeUnknown = null;
      competitionBatchDiscoveryRequired = false;
      clearCompetitionBatchRecoveryStorage();
      const message = competitionBatchErrorMessage(error, "练习未创建");
      setCompetitionBatchStatus("error", `${message}`);
      renderCompetitionBatchPanel();
      setStatus(`练习五局创建失败：${message}`);
      if (error?.code === "OWNER_OPEN_BATCH_LIMIT_REACHED") {
        await discoverOpenCompetitionBatches({ source, sourceDigest, required: false });
      }
    }
  } finally {
    if (requestSerial === competitionBatchRequestSerial
      && competitionBatchAbortController === abortController) {
      competitionBatchAbortController = null;
    }
  }
}

function requestStopCompetitionBatch() {
  if (!competitionBatchIsOpen() || activeCompetitionBatch?.uiState === "finalizing") return;
  const confirmed = window.confirm(
    "确定停止本次练习五局吗？当前及其余未完成局都会按 missing / 0 分计入，且不能继续这次练习；结果仍不入榜。"
  );
  if (!confirmed) return;
  activeCompetitionBatch.stopBatchRequested = true;
  activeCompetitionBatch.uiState = "closing";
  setCompetitionBatchStatus("checking", "已请求停止；正在结束当前运行并关闭练习…");
  renderCompetitionBatchPanel();
  if (running) {
    recordCompetitionManualInput("stop", { control: "batch_stop_button" });
    stopRequested = true;
    pauseRequested = false;
    robotLinearSpeed = 0;
    robotSteering = 0;
    competitionTick(true);
    cancelPythonCollection("batch_stopped");
  }
  if (!competitionBatchOperation) continueCompetitionBatch();
}

async function restoreCompetitionBatchFromPage() {
  const rankedIsOpen = typeof rankedEvaluationIsOpen === "function" && rankedEvaluationIsOpen();
  if (rankedIsOpen || competitionBatchRestorePending || activeCompetitionBatch) return;
  const recovery = readCompetitionBatchRecovery();
  if (!recovery) {
    await discoverOpenCompetitionBatches({ source: String(pythonEditor?.value || ""), required: true });
    return;
  }
  if (recovery.kind === "pending-create") {
    competitionBatchRestorePending = true;
    competitionBatchCreateOutcomeUnknown = {
      source: recovery.source,
      teamId: recovery.teamId,
      sourceDigest: recovery.sourceDigest
    };
    competitionBatchDiscoveryRequired = true;
    try {
      if (activeMission?.environment !== "guangyang" || activeMission?.objectTraining) {
        loadMission("guangyang", { batchInternal: true });
      }
      pythonEditor.value = recovery.source;
      if (competitionTeamIdInput) competitionTeamIdInput.value = recovery.teamId;
      updateLineNumbers();
      renderPythonHighlight();
      persistPythonDraft();
      setCompetitionBatchStatus(
        "error",
        "已恢复刷新前尚未确认的创建请求；原源码保持锁定。正在校验并查找公开进度，空结果也不会解除锁定。"
      );
      renderCompetitionBatchPanel();
      const digest = await competitionBatchSourceDigest(recovery.source);
      if (digest !== recovery.sourceDigest) {
        throw new Error("页面保存的待确认源码校验失败");
      }
      await discoverOpenCompetitionBatches({
        source: recovery.source,
        sourceDigest: recovery.sourceDigest,
        required: true
      });
    } catch (error) {
      competitionBatchDiscoveryRequired = true;
      setCompetitionBatchStatus(
        "error",
        `待确认创建状态暂时无法校验：${competitionBatchErrorMessage(error)}。原源码与待确认状态继续保留，不会创建其他源码。`
      );
      renderCompetitionBatchPanel();
    } finally {
      competitionBatchRestorePending = false;
      renderCompetitionBatchPanel();
    }
    return;
  }
  competitionBatchRestorePending = true;
  let discoverFallback = false;
  try {
    const envelope = await requestCompetitionBatch(
      `${COMPETITION_BATCH_ENDPOINT}/${encodeURIComponent(recovery.batchId)}`,
      { method: "GET" }
    );
    const digest = await competitionBatchSourceDigest(recovery.source);
    if (digest !== envelope.batch.sourceDigest) {
      throw new Error("本页面保存的源码与服务端锁定源码不一致");
    }
    if (activeMission?.environment !== "guangyang" || activeMission?.objectTraining) {
      loadMission("guangyang", { batchInternal: true });
    }
    activeCompetitionBatch = {
      source: recovery.source,
      teamId: recovery.teamId,
      batch: envelope.batch,
      currentSlot: envelope.currentSlot,
      lease: null,
      pendingRecord: null,
      currentScore: null,
      lastSlotIndex: envelope.batch.phase === "finalized"
        ? envelope.batch.slots.find(slot => slot.status === "missing")?.slotIndex || COMPETITION_BATCH_SLOT_COUNT
        : envelope.batch.nextSlotIndex,
      uiState: envelope.batch.phase === "finalized" ? "finalized" : "recovery",
      restoredFromPage: envelope.batch.phase === "open",
      probeBoundTeamFirst: envelope.batch.phase === "open" && recovery.probeBoundTeamFirst,
      stopBatchRequested: false,
      fatal: false
    };
    pythonEditor.value = recovery.source;
    if (competitionTeamIdInput) competitionTeamIdInput.value = recovery.teamId;
    updateLineNumbers();
    renderPythonHighlight();
    if (envelope.batch.phase === "finalized") {
      persistCompetitionBatchRecovery();
      setCompetitionBatchStatus("success", "已恢复完成的练习五局汇总；结果不入榜。");
    } else {
      setCompetitionBatchStatus(
        "idle",
        `已恢复练习第 ${envelope.batch.nextSlotIndex} / ${COMPETITION_BATCH_SLOT_COUNT} 局；请点击“继续当前练习五局”，页面不会自动重跑。`
      );
    }
    renderCompetitionBatchPanel();
  } catch (error) {
    const message = competitionBatchErrorMessage(error, "页面保存的恢复信息已失效");
    clearCompetitionBatchRecoveryStorage();
    activeCompetitionBatch = null;
    discoverFallback = true;
    setCompetitionBatchStatus("error", `快速恢复失败：${message}。正在重新查找未完成练习。`);
    renderCompetitionBatchPanel();
  } finally {
    competitionBatchRestorePending = false;
    renderCompetitionBatchPanel();
  }
  if (discoverFallback) {
    await discoverOpenCompetitionBatches({ source: String(pythonEditor?.value || ""), required: true });
  }
}

function loadRankedEvaluationSourceIntoWorkspace(active = activeRankedEvaluation) {
  if (!active?.source) return false;
  if (activeMission?.environment !== "guangyang" || activeMission?.objectTraining) {
    loadMission("guangyang", { batchInternal: true });
  }
  pythonEditor.value = active.source;
  if (competitionTeamIdInput) competitionTeamIdInput.value = active.teamId;
  updateLineNumbers();
  renderPythonHighlight();
  persistPythonDraft();
  return true;
}

function hydrateRankedOwnerEvaluation(evaluation, uiState = "recovery", { restoreWorkspace = false } = {}) {
  if (!evaluation) {
    activeRankedEvaluation = null;
    renderRankedEvaluationPanel();
    return null;
  }
  activeRankedEvaluation = {
    source: evaluation.lockedSource,
    teamId: evaluation.lockedTeamId,
    createdAt: evaluation.createdAt,
    expiresAt: evaluation.expiresAt,
    anonymousParticipantId: evaluation.anonymousParticipantId,
    batch: evaluation.batch,
    currentSlot: evaluation.currentSlot,
    result: evaluation.result,
    lease: null,
    pendingRecord: null,
    currentScore: null,
    lastSlotIndex: evaluation.batch.phase === "finalized"
      ? evaluation.batch.slots.find(slot => slot.status === "missing")?.slotIndex || COMPETITION_BATCH_SLOT_COUNT
      : evaluation.batch.nextSlotIndex,
    uiState: evaluation.batch.phase === "finalized" ? "finalized" : uiState,
    stopRequested: false,
    fatal: false
  };
  if (restoreWorkspace || evaluation.batch.phase === "open") {
    loadRankedEvaluationSourceIntoWorkspace(activeRankedEvaluation);
  }
  renderRankedEvaluationPanel();
  return activeRankedEvaluation;
}

function assertRankedEvaluationMatchesActive(evaluation, active = activeRankedEvaluation) {
  if (!evaluation || !active?.batch
    || evaluation.batch.batchId !== active.batch.batchId
    || evaluation.batch.sourceDigest !== active.batch.sourceDigest
    || evaluation.lockedSource !== active.source
    || evaluation.lockedTeamId !== active.teamId
    || evaluation.anonymousParticipantId !== active.anonymousParticipantId
    || evaluation.createdAt !== active.createdAt
    || evaluation.expiresAt !== active.expiresAt) {
    throw new Error("筛选五局响应与本赛季锁定记录不匹配");
  }
  return evaluation;
}

async function restoreRankedEvaluationFromServer({ quiet = false } = {}) {
  if (rankedEvaluationRestorePending || rankedEvaluationOperation) return activeRankedEvaluation;
  rankedEvaluationRestorePending = true;
  if (!quiet) setRankedEvaluationStatus("checking", "正在读取本赛季唯一一次筛选状态…");
  renderRankedEvaluationPanel();
  try {
    const payload = await requestRankedEvaluation(
      `${RANKED_EVALUATION_ENDPOINT}/me`,
      { method: "GET" },
      "me"
    );
    rankedEvaluationReady = true;
    rankedEvaluationReservationIncomplete = false;
    clearRankedEvaluationPendingCreate();
    if (payload.evaluation === null) {
      activeRankedEvaluation = null;
      setRankedEvaluationStatus("idle", "本赛季筛选机会尚未使用；创建前会再次确认，不会误触占用。");
      return null;
    }
    const restored = hydrateRankedOwnerEvaluation(payload.evaluation, "recovery");
    if (restored.batch.phase === "open") {
      setRankedEvaluationStatus(
        "idle",
        `已恢复唯一一次筛选的第 ${restored.batch.nextSlotIndex} / 5 局；页面不会自动运行。`
      );
    }
    return restored;
  } catch (error) {
    if (rankedEvaluationReservationIsIncomplete(error)) {
      activeRankedEvaluation = null;
      rankedEvaluationReady = true;
      rankedEvaluationReservationIncomplete = true;
      const pending = restoreRankedEvaluationInterruptedDraft();
      setRankedEvaluationStatus(
        "error",
        pending
          ? "创建中断，已恢复原源码和原队伍；请重新二次确认，不会创建第二次机会。"
          : "创建中断，请用原源码和原队伍重新二次确认；不同内容会由服务端拒绝。"
      );
      return null;
    }
    rankedEvaluationReservationIncomplete = false;
    rankedEvaluationReady = false;
    setRankedEvaluationStatus("error", `筛选状态读取失败：${rankedEvaluationErrorMessage(error)}。`);
    return null;
  } finally {
    rankedEvaluationRestorePending = false;
    renderRankedEvaluationPanel();
  }
}

function closeRankedEvaluationConfirmation() {
  pendingRankedEvaluationConfirmation = null;
  if (rankedEvaluationConfirmDialog?.open && typeof rankedEvaluationConfirmDialog.close === "function") {
    rankedEvaluationConfirmDialog.close();
  } else {
    rankedEvaluationConfirmDialog?.removeAttribute("open");
  }
  if (confirmRankedEvaluationButton) confirmRankedEvaluationButton.disabled = true;
}

function openRankedEvaluationConfirmation() {
  if (activeRankedEvaluation || rankedEvaluationRestorePending || rankedEvaluationOperation
    || competitionBatchIsOpen() || competitionBatchOperation || running || competitionRunStartPending) return;
  if (!isCompetitionMission() || activeMission?.environment !== "guangyang" || activeMission?.objectTraining) {
    setStatus("请先进入广阳岛综合任务");
    setRankedEvaluationStatus("error", "筛选五局只在广阳岛综合任务中运行。");
    return;
  }
  const interrupted = rankedEvaluationReservationIncomplete
    ? rankedEvaluationInterruptedCreate || restoreRankedEvaluationInterruptedDraft()
    : null;
  const source = interrupted?.source || pythonEditor.value.trim();
  if (!source) {
    setStatus("请先写 Python 代码");
    setRankedEvaluationStatus("error", "源码为空，尚未占用本赛季筛选机会。");
    pythonEditor.focus();
    return;
  }
  if (!rankedSourceFitsByteLimit(source)) {
    setStatus("筛选源码过大");
    setRankedEvaluationStatus(
      "error",
      "筛选源码按 UTF-8 计算不能超过 128 KiB；当前不会占用本赛季机会，请精简后重新确认。"
    );
    pythonEditor.focus();
    return;
  }
  if (!pythonReady) {
    setStatus("Python 还在准备中");
    return;
  }
  let teamId;
  try {
    teamId = interrupted?.teamId || normalizeCompetitionBatchTeamId(currentCompetitionTeamId());
  } catch (error) {
    const message = String(error?.message || error);
    setRankedEvaluationStatus("error", `${message}；尚未占用本赛季筛选机会。`);
    competitionTeamIdInput?.focus?.();
    return;
  }
  pendingRankedEvaluationConfirmation = { source, teamId };
  if (confirmRankedEvaluationButton) confirmRankedEvaluationButton.disabled = false;
  if (typeof rankedEvaluationConfirmDialog?.showModal === "function") {
    if (!rankedEvaluationConfirmDialog.open) rankedEvaluationConfirmDialog.showModal();
  } else {
    rankedEvaluationConfirmDialog?.setAttribute("open", "");
  }
}

async function createConfirmedRankedEvaluation() {
  const pending = pendingRankedEvaluationConfirmation;
  if (!pending || activeRankedEvaluation || rankedEvaluationOperation || rankedEvaluationRestorePending) return;
  let currentTeamId = "";
  try {
    currentTeamId = normalizeCompetitionBatchTeamId(currentCompetitionTeamId());
  } catch (_error) {}
  const interrupted = rankedEvaluationReservationIncomplete ? rankedEvaluationInterruptedCreate : null;
  if (pythonEditor.value.trim() !== pending.source
    || currentTeamId !== pending.teamId
    || !rankedSourceFitsByteLimit(pending.source)
    || (interrupted && (pending.source !== interrupted.source || pending.teamId !== interrupted.teamId))) {
    closeRankedEvaluationConfirmation();
    setRankedEvaluationStatus("error", "源码或队伍在确认期间发生变化，请重新检查并再次确认；机会尚未占用。");
    return;
  }
  try {
    rememberRankedEvaluationPendingCreate(pending.source, pending.teamId);
  } catch (error) {
    closeRankedEvaluationConfirmation();
    const message = String(error?.message || "浏览器无法保存筛选恢复信息，创建请求未发送");
    setRankedEvaluationStatus("error", message);
    setStatus("筛选尚未创建：恢复信息保存失败");
    return;
  }
  closeRankedEvaluationConfirmation();
  const requestSerial = ++rankedEvaluationRequestSerial;
  const abortController = new AbortController();
  rankedEvaluationAbortController?.abort();
  rankedEvaluationAbortController = abortController;
  const provisional = {
    source: pending.source,
    teamId: pending.teamId,
    createdAt: null,
    expiresAt: null,
    anonymousParticipantId: null,
    batch: null,
    currentSlot: null,
    result: null,
    lease: null,
    pendingRecord: null,
    currentScore: null,
    lastSlotIndex: 1,
    uiState: "creating",
    stopRequested: false,
    fatal: false
  };
  rankedEvaluationReservationIncomplete = false;
  activeRankedEvaluation = provisional;
  setCompetitionBatchSourceLock(true);
  setRankedEvaluationStatus(
    "checking",
    "二次确认已完成，正在锁定源码与队伍；从此关闭、过期、异常或缺局都按 0 分计入。"
  );
  renderRankedEvaluationPanel();
  try {
    const payload = await requestRankedEvaluation(
      RANKED_EVALUATION_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: pending.source, teamId: pending.teamId })
      },
      "create",
      abortController.signal
    );
    if (requestSerial !== rankedEvaluationRequestSerial) return;
    if (payload.evaluation.lockedSource !== pending.source
      || payload.evaluation.lockedTeamId !== pending.teamId
      || payload.evaluation.batch.sourceDigest !== await competitionBatchSourceDigest(pending.source)) {
      throw new Error("服务端没有按二次确认内容锁定筛选");
    }
    clearRankedEvaluationPendingCreate();
    hydrateRankedOwnerEvaluation(payload.evaluation, "leasing", { restoreWorkspace: true });
    setRankedEvaluationStatus("checking", "源码与队伍已锁定；即将严格按顺序自动完成第 1 / 5 局。");
    continueRankedEvaluation();
  } catch (error) {
    if (requestSerial !== rankedEvaluationRequestSerial || error?.name === "AbortError") return;
    const differentLockedAttempt = String(error?.code || "") === "RANKED_ATTEMPT_ALREADY_EXISTS";
    if (differentLockedAttempt) clearRankedEvaluationPendingCreate();
    activeRankedEvaluation = null;
    setRankedEvaluationStatus(
      "error",
      `创建结果需要重新确认：${rankedEvaluationErrorMessage(error)}。正在从当前账号恢复唯一记录。`
    );
    await restoreRankedEvaluationFromServer({ quiet: true });
    if (differentLockedAttempt && rankedEvaluationReservationIncomplete && !activeRankedEvaluation) {
      rankedEvaluationReservationIncomplete = false;
      rankedEvaluationReady = false;
      setRankedEvaluationStatus(
        "error",
        "当前源码或队伍与已保留的唯一筛选不一致，已停止重试；请联系管理员处理。"
      );
    }
  } finally {
    if (requestSerial === rankedEvaluationRequestSerial
      && rankedEvaluationAbortController === abortController) rankedEvaluationAbortController = null;
    renderRankedEvaluationPanel();
  }
}

async function leaseCurrentRankedEvaluationSlot() {
  const active = activeRankedEvaluation;
  if (!rankedEvaluationIsOpen(active?.batch)) throw new Error("当前没有可运行的筛选五局");
  const batchId = active.batch.batchId;
  const slotIndex = active.batch.nextSlotIndex;
  active.uiState = "leasing";
  active.currentScore = null;
  setRankedEvaluationStatus("checking", `正在准备筛选第 ${slotIndex} / 5 局；未来局尚未下发。`);
  renderRankedEvaluationPanel();
  const payload = await requestRankedEvaluation(
    `${RANKED_EVALUATION_ENDPOINT}/${encodeURIComponent(batchId)}/current-slot/lease`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slotIndex })
    },
    "lease"
  );
  const { envelope, lease } = normalizeRankedLeaseResponse(
    payload,
    batchId,
    slotIndex,
    active.teamId
  );
  assertRankedEvaluationMatchesActive(envelope.evaluation, active);
  active.batch = envelope.evaluation.batch;
  active.currentSlot = envelope.evaluation.currentSlot;
  active.lease = lease;
  active.lastSlotIndex = slotIndex;
  if (competitionTeamIdInput) competitionTeamIdInput.value = active.teamId;
  applyCompetitionBatchLeaseScene(lease);
  return lease;
}

async function submitCurrentRankedEvaluationSlot(record) {
  const active = activeRankedEvaluation;
  const lease = active?.lease;
  const slotIndex = lease?.slotIndex;
  if (!active || !lease || !record || !Number.isSafeInteger(slotIndex)) {
    throw new Error("筛选当前局运行记录尚未就绪");
  }
  active.uiState = "finalizing";
  active.currentScore = Number(record.result?.score);
  active.pendingRecord = record;
  setRankedEvaluationStatus("checking", `筛选第 ${slotIndex} 局正在服务端重算并写入；确认前不会进入下一局。`);
  renderRankedEvaluationPanel();
  const payload = await requestRankedEvaluation(
    `${RANKED_EVALUATION_ENDPOINT}/${encodeURIComponent(active.batch.batchId)}`
      + `/slots/${slotIndex}/sessions/${encodeURIComponent(lease.session.sessionId)}/submissions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record)
    },
    "submit"
  );
  const evaluation = payload.evaluation;
  assertRankedEvaluationMatchesActive(evaluation, active);
  const finalizedSlot = evaluation.batch.slots[slotIndex - 1];
  if (!finalizedSlot?.final || finalizedSlot.status === "pending") {
    throw new Error("服务端未确认筛选本局已经写入");
  }
  active.batch = evaluation.batch;
  active.currentSlot = evaluation.currentSlot;
  active.pendingRecord = null;
  active.lease = null;
  active.currentScore = finalizedSlot.score;
  return payload;
}

async function refreshFinalizedRankedEvaluation() {
  const active = activeRankedEvaluation;
  if (!active?.batch || active.batch.phase !== "finalized") return active;
  const payload = await requestRankedEvaluation(
    `${RANKED_EVALUATION_ENDPOINT}/me`,
    { method: "GET" },
    "me"
  );
  assertRankedEvaluationMatchesActive(payload.evaluation, active);
  return hydrateRankedOwnerEvaluation(payload.evaluation, "finalized");
}

async function closeActiveRankedEvaluation() {
  const active = activeRankedEvaluation;
  if (!rankedEvaluationIsOpen(active?.batch)) return active?.batch || null;
  active.uiState = "closing";
  setRankedEvaluationStatus("checking", "正在结算筛选五局；当前及其余缺局将按 missing / 0 分计入。");
  renderRankedEvaluationPanel();
  const payload = await requestRankedEvaluation(
    `${RANKED_EVALUATION_ENDPOINT}/${encodeURIComponent(active.batch.batchId)}/close`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    "close"
  );
  assertRankedEvaluationMatchesActive(payload.evaluation, active);
  active.batch = payload.evaluation.batch;
  active.currentSlot = null;
  active.lease = null;
  active.pendingRecord = null;
  active.stopRequested = false;
  await refreshFinalizedRankedEvaluation();
  renderRankedEvaluationPanel();
  return activeRankedEvaluation?.batch || null;
}

async function runRankedEvaluationSequence() {
  const active = activeRankedEvaluation;
  if (!rankedEvaluationIsOpen(active?.batch)) return;
  try {
    while (active === activeRankedEvaluation && rankedEvaluationIsOpen(active.batch)) {
      if (active.stopRequested) {
        await closeActiveRankedEvaluation();
        return;
      }
      if (active.pendingRecord && active.lease) {
        await submitCurrentRankedEvaluationSlot(active.pendingRecord);
      } else {
        const lease = active.lease || await leaseCurrentRankedEvaluationSlot();
        if (active.stopRequested) {
          await closeActiveRankedEvaluation();
          return;
        }
        active.uiState = "running";
        active.currentScore = null;
        setRankedEvaluationStatus("checking", `筛选第 ${lease.slotIndex} / 5 局正使用锁定源码自动运行。`);
        renderRankedEvaluationPanel();
        await runProgram({ rankedManaged: true });
        if (active.stopRequested) {
          await closeActiveRankedEvaluation();
          return;
        }
        const record = latestCompetitionRecord;
        if (!record || record.runId !== lease.session.runId
          || record.serverSessionId !== lease.session.sessionId
          || record.challengeDigest !== lease.session.challengeDigest) {
          throw new Error("筛选本局未生成与租约匹配的运行记录");
        }
        await submitCurrentRankedEvaluationSlot(record);
      }
      if (active.batch.phase === "finalized") {
        await refreshFinalizedRankedEvaluation();
        setStatus("筛选五局已结算（本地参考）");
        addLog("筛选五局已结算并取得服务端名次；结果 authoritative: false。", true);
        return;
      }
      active.currentScore = null;
    }
  } catch (error) {
    if (active !== activeRankedEvaluation) return;
    const fatal = [
      "SOURCE_LOCKED", "RANKED_TEAM_LOCKED", "BATCH_EXPIRED", "BATCH_OWNER_MISMATCH",
      "BATCH_FINALIZED", "BATCH_NOT_FOUND", "RANKED_ATTEMPT_ALREADY_EXISTS",
      "SUBMISSION_DEADLINE_EXPIRED", "RANKED_SUBMISSION_OUTSIDE_WINDOW",
      "BATCH_RECEIPT_EVIDENCE_CORRUPTED", "BATCH_FINALIZATION_EVIDENCE_CONFLICT"
    ].includes(String(error?.code || ""));
    active.uiState = "error";
    active.fatal = fatal;
    if (fatal) {
      active.lease = null;
      active.pendingRecord = null;
    }
    const message = rankedEvaluationErrorMessage(error);
    const evidenceFailure = [
      "BATCH_RECEIPT_EVIDENCE_CORRUPTED", "BATCH_FINALIZATION_EVIDENCE_CONFLICT"
    ].includes(String(error?.code || ""));
    const deadlineFailure = [
      "SUBMISSION_DEADLINE_EXPIRED", "RANKED_SUBMISSION_OUTSIDE_WINDOW"
    ].includes(String(error?.code || ""));
    setRankedEvaluationStatus(
      "error",
      evidenceFailure
        ? message
        : deadlineFailure
          ? `${message} 请结束筛选以按 0 分结算当前及其余缺局。`
          : fatal
        ? `当前筛选不能继续：${message}。请刷新读取最终状态。`
        : `本局尚未推进：${message}。点击“恢复并继续筛选”可从本局重试。`
    );
    setStatus(`筛选五局暂停：${message}`);
    addLog(`筛选五局暂停：${message}。`);
    renderRankedEvaluationPanel();
  }
}

function continueRankedEvaluation() {
  if (rankedEvaluationOperation || !rankedEvaluationIsOpen() || activeRankedEvaluation?.fatal) return;
  const operation = runRankedEvaluationSequence();
  rankedEvaluationOperation = operation;
  renderRankedEvaluationPanel();
  operation.finally(() => {
    if (rankedEvaluationOperation === operation) rankedEvaluationOperation = null;
    renderRankedEvaluationPanel();
  });
  return operation;
}

function recoverOrContinueRankedEvaluation() {
  const active = activeRankedEvaluation;
  if (!active) return;
  if (active.batch?.phase === "finalized") {
    loadRankedEvaluationSourceIntoWorkspace(active);
    setRankedEvaluationStatus("success", "已把本赛季锁定源码恢复到编辑器；筛选结果与名次不会改变。");
    setStatus("已恢复本赛季筛选源码");
    return;
  }
  if (!rankedEvaluationIsOpen(active.batch) || rankedEvaluationOperation || active.fatal) return;
  loadRankedEvaluationSourceIntoWorkspace(active);
  active.uiState = "leasing";
  setRankedEvaluationStatus("checking", "正在继续唯一一次筛选；不会创建第二次机会。");
  continueRankedEvaluation();
}

function requestStopRankedEvaluation() {
  const active = activeRankedEvaluation;
  if (!rankedEvaluationIsOpen(active?.batch) || active.uiState === "finalizing") return;
  const confirmed = window.confirm(
    "确定结束本赛季唯一一次筛选五局吗？当前及其余缺局都会按 missing / 0 分结算，不能撤销、换卷或重新创建。"
  );
  if (!confirmed) return;
  active.stopRequested = true;
  active.uiState = "closing";
  setRankedEvaluationStatus("checking", "已确认结束；正在停止当前运行并按 0 分结算缺局…");
  renderRankedEvaluationPanel();
  if (running) {
    recordCompetitionManualInput("stop", { control: "ranked_stop_button" });
    stopRequested = true;
    pauseRequested = false;
    robotLinearSpeed = 0;
    robotSteering = 0;
    competitionTick(true);
    cancelPythonCollection("ranked_stopped");
  }
  if (!rankedEvaluationOperation) continueRankedEvaluation();
}

async function readBoundedResponseBytes(response, maximumBytes) {
  const declaredLengthText = response.headers.get("content-length");
  if (declaredLengthText && /^\d+$/.test(declaredLengthText)) {
    const declaredLength = Number(declaredLengthText);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
      throw new Error("后台运行记录超过浏览器回放大小限制");
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maximumBytes) throw new Error("后台运行记录超过浏览器回放大小限制");
    return buffer;
  }
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error("后台运行记录超过浏览器回放大小限制");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  chunks.forEach(chunk => {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return buffer;
}

async function readBoundedResponseText(response, maximumBytes) {
  const buffer = await readBoundedResponseBytes(response, maximumBytes);
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

async function sha256Hex(buffer) {
  if (!globalThis.crypto?.subtle?.digest) {
    throw new Error("当前浏览器不支持后台运行记录完整性校验");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function requestArchivedRunRecord(submissionId, externalSignal = null, expectedSummary = null) {
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), RUN_RECORD_VERIFICATION_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${PERSONAL_RECORDS_ENDPOINT}/${encodeURIComponent(submissionId)}/run-record`,
      {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal
      }
    );
    handleCompetitionAuthenticationFailure(response);
    const buffer = await readBoundedResponseBytes(response, MAX_ARCHIVED_REPLAY_RESPONSE_BYTES);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (_error) {
      throw new Error("后台运行记录不是有效 UTF-8");
    }
    let payload = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        throw new Error("后台运行记录不是有效 JSON");
      }
    }
    if (!response.ok) {
      throw new Error(payload?.error?.message || `读取后台运行记录失败（HTTP ${response.status}）`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("后台运行记录格式不兼容");
    }
    const responseDigest = String(response.headers.get("x-content-sha256") || "").trim().toLowerCase();
    const expectedDigest = String(expectedSummary?.recordSha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(responseDigest) || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new Error("后台运行记录缺少有效的完整性摘要");
    }
    if (responseDigest !== expectedDigest) throw new Error("后台运行记录摘要与存档列表不匹配");
    if (expectedSummary?.recordByteLength !== undefined
      && (!Number.isSafeInteger(expectedSummary.recordByteLength)
        || expectedSummary.recordByteLength < 1
        || expectedSummary.recordByteLength !== buffer.byteLength)) {
      throw new Error("后台运行记录长度与存档列表不匹配");
    }
    const actualDigest = await sha256Hex(buffer);
    if (actualDigest !== responseDigest) throw new Error("后台运行记录完整性校验失败");
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      if (externalSignal?.aborted) throw new DOMException("请求已取消", "AbortError");
      throw new Error("读取后台运行记录超时");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

async function loadLatestArchivedCompetitionRecord() {
  if (archivedReplayLoadPromise) return archivedReplayLoadPromise;
  if (running) throw new Error("当前程序仍在运行，无法载入后台存档");
  const loadGeneration = ++archivedRecordLoadGeneration;
  const abortController = new AbortController();
  archivedRecordLoadAbortController = abortController;
  const operation = (async () => {
    const { response, payload } = await requestVerificationEndpoint(
      `${PERSONAL_RECORDS_ENDPOINT}?limit=1`,
      { method: "GET" },
      RUN_RECORD_VERIFICATION_TIMEOUT_MS,
      abortController.signal
    );
    if (!response.ok) throw new Error(payload?.error?.message || `读取比赛存档失败（HTTP ${response.status}）`);
    if (!payload || payload.schemaVersion !== "chenlong.records/v1"
      || payload.authoritative !== false || !Array.isArray(payload.records)) {
      throw new Error("比赛存档列表格式不兼容");
    }
    const summary = payload.records.find(item => item
      && typeof item === "object"
      && /^sub_[a-f0-9]{32}$/.test(item.submissionId || item.id || ""));
    if (!summary) return null;
    const submissionId = summary.submissionId || summary.id;
    const record = await requestArchivedRunRecord(submissionId, abortController.signal, summary);
    if (typeof record.schemaVersion !== "string"
      || (summary.sessionId && record.serverSessionId !== summary.sessionId)
      || (summary.runId && record.runId !== summary.runId)
      || (summary.challengeDigest && record.challengeDigest !== summary.challengeDigest)) {
      throw new Error("后台运行记录与存档摘要不匹配");
    }
    const ReplayPlayer = globalThis.CompetitionCore?.ReplayPlayer;
    if (!ReplayPlayer) throw new Error("回放核心尚未加载");
    let archivedFrames;
    try {
      archivedFrames = new ReplayPlayer(record).trajectory();
    } catch (_error) {
      throw new Error("后台运行记录无法回放");
    }
    if (!Array.isArray(archivedFrames) || archivedFrames.length === 0) {
      throw new Error("后台运行记录中没有可回放轨迹");
    }
    if (loadGeneration !== archivedRecordLoadGeneration || abortController.signal.aborted || running) {
      throw new DOMException("请求已取消", "AbortError");
    }
    latestCompetitionRecord = record;
    latestCompetitionSubmissionReceipt = {
      schemaVersion: SUBMISSION_RECEIPT_SCHEMA_VERSION,
      submissionId,
      sessionId: summary.sessionId,
      challengeDigest: summary.challengeDigest,
      authoritative: false,
      duplicate: true,
      recordRef: record
    };
    exportRunRecordButton.disabled = false;
    resetCompetitionVerificationResult();
    setCompetitionSubmissionResult("idle", `已载入后台存档 ${submissionId.slice(-8)} · authoritative: false`);
    updateCompetitionSubmissionButton();
    renderCompetitionHud(record.result, true);
    return record;
  })();
  archivedReplayLoadPromise = operation;
  try {
    return await operation;
  } finally {
    if (archivedReplayLoadPromise === operation) {
      archivedReplayLoadPromise = null;
      if (archivedRecordLoadAbortController === abortController) archivedRecordLoadAbortController = null;
    }
  }
}

function cancelArchivedCompetitionRecordLoad() {
  const active = Boolean(archivedReplayLoadPromise || archivedRecordLoadAbortController || replayRecordLoadOperation);
  if (!active) return false;
  archivedRecordLoadGeneration += 1;
  archivedRecordLoadAbortController?.abort();
  archivedRecordLoadAbortController = null;
  archivedReplayLoadPromise = null;
  replayRecordLoadOperation = null;
  replayRecordLoading = false;
  replayRunRecordButton?.setAttribute("aria-busy", "false");
  setReplayButtonState(false);
  return true;
}

async function ensureLatestCompetitionRecord(action) {
  if (latestCompetitionRecord) return latestCompetitionRecord;
  const actionKey = ({ 回放: "replay", 导出: "export", 校验: "verify", 提交: "submit" })[action] || "record";
  if (running) {
    const message = `当前程序仍在运行，请结束后再${action}`;
    setStatus(message);
    setCompetitionRecordActionStatus(actionKey, "warning", `${action}未执行：${message}`);
    return null;
  }
  setStatus(`正在读取当前账户最近一次比赛存档，以便${action}…`);
  setCompetitionRecordActionStatus(actionKey, "checking", `${action}：正在读取最近一次比赛存档…`);
  try {
    const record = await loadLatestArchivedCompetitionRecord();
    if (!record) {
      explainMissingCompetitionRecord(action);
    } else {
      setStatus(`后台存档已载入，正在${action}`);
      setCompetitionRecordActionStatus(actionKey, "checking", `${action}：最近存档已载入，正在执行…`);
    }
    return record;
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus(`已取消后台存档载入，未执行${action}`);
      setCompetitionRecordActionStatus(actionKey, "warning", `${action}已取消：后台存档载入已停止`);
      return null;
    }
    const message = String(error?.message || error).slice(0, 140);
    setStatus(`后台存档读取失败：${message}`);
    setCompetitionRecordActionStatus(actionKey, "error", `${action}失败：${message}`);
    addLog(`${action}准备失败：${message}。`);
    return null;
  }
}

async function probeVerificationService() {
  setVerificationServiceHealth("checking");
  try {
    const { response, payload } = await requestVerificationEndpoint(
      VERIFICATION_HEALTH_ENDPOINT,
      { method: "GET" },
      VERIFICATION_HEALTH_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || payload.schemaVersion !== "chenlong.backend-health/v1"
      || payload.status !== "ok"
      || payload.authoritative !== false
      || payload.capabilities?.runRecordVerification !== true) {
      throw new Error("校验服务健康响应不兼容");
    }
    setVerificationServiceHealth("online");
  } catch (error) {
    setVerificationServiceHealth("offline", error?.message || String(error));
  }
}

function extractVerificationReport(payload) {
  const candidates = [payload?.report, payload?.verification, payload];
  return candidates.find(candidate => candidate
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && typeof candidate.status === "string") || null;
}

function verificationScopeSummary(report) {
  const value = report && typeof report === "object" && !Array.isArray(report) ? report : {};
  const deterministicCandidate = value.verificationScope?.deterministic?.status;
  const deterministicStatus = ["complete", "incomplete"].includes(deterministicCandidate)
    ? deterministicCandidate
    : "unknown";
  const visionCandidate = value.visionStatus ?? value.verificationScope?.vision;
  const visionStatus = ["not_used", "not_recomputed", "matched"].includes(visionCandidate)
    ? visionCandidate
    : "unknown";
  return { deterministicStatus, visionStatus };
}

function verificationStatusLabel(status, report = null) {
  const normalized = String(status || "").toLowerCase();
  const { deterministicStatus } = verificationScopeSummary(report);
  return ({
    verified: "确定性校验通过",
    partial: deterministicStatus === "incomplete" ? "确定性校验不完整" : "旧版校验不完整",
    invalid: "记录无效",
    error: "校验失败"
  })[normalized] || "状态未知";
}

function verificationReportMessage(report) {
  const reasonLabels = {
    vision_detections_not_recomputed: "视觉识别结果未重算",
    recomputation_incomplete: "确定性重算未完成",
    recorded_result_missing: "原始成绩缺失",
    recorded_result_incomplete: "原始成绩字段不完整",
    verification_failed: "记录与重算结果不一致"
  };
  const status = report.status;
  const scope = verificationScopeSummary(report);
  const details = [];
  const reason = Array.isArray(report.reasonCodes) ? report.reasonCodes[0] : null;
  const errorCode = report.error?.code;
  const mismatchCount = Number(report.replay?.mismatchCount);
  if (reason) details.push(reasonLabels[reason] || String(reason).slice(0, 80));
  else if (errorCode) details.push(String(errorCode).slice(0, 80));
  else if (Number.isSafeInteger(mismatchCount) && mismatchCount > 0) details.push(`${mismatchCount} 处差异`);
  if (status === "verified" && scope.visionStatus === "not_recomputed"
    && reason !== "vision_detections_not_recomputed") {
    details.push("视觉识别结果未重算");
  }
  return `${status} · ${verificationStatusLabel(status, report)}${details.length ? `（${details.join("，")}）` : ""} · authoritative: false`;
}

function explainMissingCompetitionRecord(action) {
  const message = `暂无可${action}的运行记录，请先运行并结束一次比赛`;
  const actionKey = ({ 回放: "replay", 导出: "export", 校验: "verify", 提交: "submit" })[action] || "record";
  setStatus(message);
  setCompetitionRecordActionStatus(actionKey, "warning", `${action}未执行：暂无运行记录`);
  if (competitionLatestEvent) {
    competitionLatestEvent.textContent = message;
    competitionLatestEvent.classList.remove("is-violation");
  }
  return message;
}

async function verifyLatestCompetitionRecordOnServer() {
  setCompetitionRecordActionStatus("verify", "checking", "服务端校验：正在准备运行记录…");
  if (!latestCompetitionRecord) {
    const restoredRecord = await ensureLatestCompetitionRecord("校验");
    if (!restoredRecord) {
      setCompetitionVerificationResult("idle", "没有可校验的运行记录 · authoritative: false");
      return;
    }
  }
  if (serverVerificationInFlight) {
    setCompetitionRecordActionStatus("verify", "checking", "服务端校验正在进行，请稍候…");
    return;
  }
  const record = latestCompetitionRecord;
  const requestSerial = ++serverVerificationRequestSerial;
  const abortController = new AbortController();
  serverVerificationAbortController?.abort();
  serverVerificationAbortController = abortController;
  serverVerificationInFlight = true;
  setCompetitionVerificationResult("checking", "正在上传并重算 · authoritative: false");
  updateServerVerificationButton();
  try {
    const upload = await prepareCompetitionRecordUpload(record);
    const { response, payload } = await requestVerificationEndpoint(
      RUN_RECORD_VERIFICATION_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(upload.contentEncoding ? { "Content-Encoding": upload.contentEncoding } : {})
        },
        body: upload.body
      },
      RUN_RECORD_VERIFICATION_TIMEOUT_MS,
      abortController.signal
    );
    if (requestSerial !== serverVerificationRequestSerial || record !== latestCompetitionRecord) return;
    if (response.status === 413 && !payload?.error?.message) {
      throw normalizeRecordServiceError(
        payload,
        `公网入口拒绝了本次运行记录（原始 ${formatUploadByteLength(upload.rawByteLength)}`
          + `，上传 ${formatUploadByteLength(upload.wireByteLength)}），请联系管理员提高上传限制`
      );
    }
    const report = extractVerificationReport(payload);
    if (!report) {
      throw new Error(response.ok ? "校验服务响应缺少报告" : `校验服务返回 HTTP ${response.status}`);
    }
    if (report.schemaVersion !== "chenlong.verification-report/v1") {
      throw new Error("校验服务报告版本不兼容");
    }
    if (!response.ok && !["invalid", "error"].includes(report.status)) {
      throw new Error(`校验服务返回 HTTP ${response.status}`);
    }
    if (!["verified", "partial", "invalid", "error"].includes(report.status)) {
      throw new Error(`未知校验状态：${String(report.status).slice(0, 40)}`);
    }
    if (report.authoritative !== false) {
      throw new Error("校验报告缺少 authoritative: false 安全标记");
    }
    setVerificationServiceHealth("online");
    setCompetitionVerificationResult(report.status, verificationReportMessage(report));
    const resultLabel = verificationStatusLabel(report.status, report);
    const feedbackStatus = report.status === "verified"
      ? "success"
      : report.status === "partial" ? "warning" : "error";
    setStatus(`服务端校验完成：${resultLabel}`);
    setCompetitionRecordActionStatus("verify", feedbackStatus, `服务端校验完成：${resultLabel}`);
    addLog(`服务端校验：${report.status}（非权威结果）。`, true);
  } catch (error) {
    if (requestSerial !== serverVerificationRequestSerial || record !== latestCompetitionRecord) return;
    const message = String(error?.message || error).slice(0, 120);
    setCompetitionVerificationResult("error", `error · ${message} · authoritative: false`);
    setStatus(`服务端校验失败：${message}`);
    setCompetitionRecordActionStatus("verify", "error", `服务端校验失败：${message}`);
    addLog(`服务端校验失败：${message}。`);
    probeVerificationService();
  } finally {
    if (requestSerial === serverVerificationRequestSerial) {
      if (serverVerificationAbortController === abortController) serverVerificationAbortController = null;
      serverVerificationInFlight = false;
      updateServerVerificationButton();
    }
  }
}

async function performLatestCompetitionRecordSubmission(record, session) {
  if (!recordMatchesActiveServerSession(record) || competitionSubmissionInFlight) {
    updateCompetitionSubmissionButton();
    if (!latestCompetitionRecord) {
      explainMissingCompetitionRecord("提交");
      setCompetitionSubmissionResult("idle", "请先运行并结束一次比赛，再提交存档 · authoritative: false");
    } else if (!activeCompetitionServerSession) {
      setCompetitionSubmissionResult("error", "本次记录未绑定服务端场次；请重新运行后提交 · authoritative: false");
      setStatus("本次记录没有可提交的服务端场次");
      setCompetitionRecordActionStatus("submit", "warning", "提交未执行：本次记录未绑定服务端场次");
    } else if (Date.parse(activeCompetitionServerSession.expiresAt) <= Date.now()) {
      setCompetitionSubmissionResult("error", "服务端场次已过期；请重新运行后提交 · authoritative: false");
      setStatus("服务端比赛场次已过期");
      setCompetitionRecordActionStatus("submit", "error", "提交失败：服务端比赛场次已过期");
    } else {
      setCompetitionSubmissionResult("error", "运行记录与当前服务端场次不匹配；请重新运行后提交 · authoritative: false");
      setStatus("运行记录与当前服务端场次不匹配");
      setCompetitionRecordActionStatus("submit", "error", "提交失败：运行记录与当前服务端场次不匹配");
    }
    return false;
  }
  const requestSerial = ++competitionSubmissionRequestSerial;
  const abortController = new AbortController();
  competitionSubmissionAbortController?.abort();
  competitionSubmissionAbortController = abortController;
  competitionSubmissionInFlight = true;
  setCompetitionSubmissionResult("checking", "正在校验并写入本地比赛存档… · authoritative: false");
  setCompetitionRecordActionStatus("submit", "checking", "比赛存档：正在校验并写入…");
  updateCompetitionSubmissionButton();
  try {
    const upload = await prepareCompetitionRecordUpload(record);
    const { response, payload } = await requestVerificationEndpoint(
      `/api/v1/sessions/${encodeURIComponent(session.sessionId)}/submissions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(upload.contentEncoding ? { "Content-Encoding": upload.contentEncoding } : {}),
          Authorization: `Bearer ${session.submitToken}`
        },
        body: upload.body
      },
      RUN_RECORD_VERIFICATION_TIMEOUT_MS,
      abortController.signal
    );
    if (requestSerial !== competitionSubmissionRequestSerial
      || record !== latestCompetitionRecord
      || session !== activeCompetitionServerSession) return false;
    setVerificationServiceHealth("online");
    if (!response.ok) {
      const fallback = response.status === 413
        ? `公网入口拒绝了本次运行记录（原始 ${formatUploadByteLength(upload.rawByteLength)}`
          + `，上传 ${formatUploadByteLength(upload.wireByteLength)}），请联系管理员提高上传限制`
        : `提交失败（HTTP ${response.status}）`;
      throw normalizeRecordServiceError(payload, fallback);
    }
    const receipt = payload?.receipt && typeof payload.receipt === "object" ? payload.receipt : payload;
    const report = receipt?.verification;
    if (!receipt || receipt.schemaVersion !== SUBMISSION_RECEIPT_SCHEMA_VERSION
      || receipt.authoritative !== false
      || typeof receipt.duplicate !== "boolean"
      || receipt.sessionId !== session.sessionId
      || receipt.challengeDigest !== session.challengeDigest
      || !/^sub_[a-f0-9]{32}$/.test(receipt.submissionId || "")
      || !report || report.schemaVersion !== "chenlong.verification-report/v1"
      || report.authoritative !== false
      || !["verified", "partial", "invalid", "error"].includes(report.status)) {
      throw new Error("服务端提交回执不兼容");
    }
    latestCompetitionSubmissionReceipt = { ...receipt, recordRef: record };
    const duplicateLabel = receipt.duplicate ? "重复记录已确认" : "已写入存档";
    setCompetitionSubmissionResult(
      report.status,
      `${duplicateLabel} ${receipt.submissionId.slice(-8)} · ${report.status} · authoritative: false`
    );
    setCompetitionVerificationResult(report.status, verificationReportMessage(report));
    const feedbackStatus = report.status === "verified"
      ? "success"
      : report.status === "partial" ? "warning" : "error";
    setStatus(`比赛存档${receipt.duplicate ? "已确认" : "提交完成"}：${receipt.submissionId.slice(-8)}`);
    setCompetitionRecordActionStatus(
      "submit",
      feedbackStatus,
      `${duplicateLabel}：${receipt.submissionId.slice(-8)}（${report.status}）`
    );
    addLog(`比赛记录${receipt.duplicate ? "已存在" : "已存档"}：${receipt.submissionId}（${report.status}，非权威）。`, true);
    if (competitionRecordsDialog?.open) void loadCompetitionRecordsPreview();
    return true;
  } catch (error) {
    if (requestSerial !== competitionSubmissionRequestSerial
      || record !== latestCompetitionRecord
      || session !== activeCompetitionServerSession) return false;
    const message = String(error?.message || error).slice(0, 120);
    setCompetitionSubmissionResult("error", `提交失败：${message} · 本地记录未受影响`);
    setStatus(`比赛存档提交失败：${message}`);
    setCompetitionRecordActionStatus("submit", "error", `提交失败：${message}`);
    addLog(`比赛存档提交失败：${message}。`);
    return false;
  } finally {
    if (requestSerial === competitionSubmissionRequestSerial) {
      if (competitionSubmissionAbortController === abortController) competitionSubmissionAbortController = null;
      competitionSubmissionInFlight = false;
      updateCompetitionSubmissionButton();
    }
  }
}

async function submitLatestCompetitionRecord() {
  if (competitionSubmissionOperation) {
    setCompetitionRecordActionStatus("submit", "checking", "比赛存档正在提交，请稍候…");
    return competitionSubmissionOperation.promise;
  }
  setCompetitionRecordActionStatus("submit", "checking", "比赛存档：正在准备运行记录…");
  if (!latestCompetitionRecord) {
    const restoredRecord = await ensureLatestCompetitionRecord("提交");
    if (!restoredRecord) {
      setCompetitionSubmissionResult("idle", "没有可提交的运行记录 · authoritative: false");
      return false;
    }
  }
  if (competitionRecordAlreadyArchived()) {
    const shortId = latestCompetitionSubmissionReceipt.submissionId.slice(-8);
    setStatus("最近一次后台记录已经存档，无需重复提交");
    setCompetitionSubmissionResult(
      "idle",
      `最近记录 ${shortId} 已存档 · authoritative: false`
    );
    setCompetitionRecordActionStatus("submit", "success", `比赛存档已存在：${shortId}，无需重复提交`);
    updateCompetitionSubmissionButton();
    return true;
  }
  const operation = {
    record: latestCompetitionRecord,
    session: activeCompetitionServerSession,
    promise: null
  };
  const submissionPromise = performLatestCompetitionRecordSubmission(operation.record, operation.session);
  operation.promise = submissionPromise.then(
    saved => {
      if (competitionSubmissionOperation === operation) competitionSubmissionOperation = null;
      return saved === true;
    },
    error => {
      if (competitionSubmissionOperation === operation) competitionSubmissionOperation = null;
      const message = String(error?.message || error).slice(0, 120);
      setCompetitionSubmissionResult("error", `提交失败：${message} · 本地记录未受影响`);
      setStatus(`比赛存档提交失败：${message}`);
      setCompetitionRecordActionStatus("submit", "error", `提交失败：${message}`);
      updateCompetitionSubmissionButton();
      return false;
    }
  );
  competitionSubmissionOperation = operation;
  return operation.promise;
}

function competitionRecordAlreadyArchived(record = latestCompetitionRecord) {
  return Boolean(record && latestCompetitionSubmissionReceipt?.recordRef === record);
}

function competitionRecordStatusLabel(status, verification = null) {
  if (status === "pending" || status === "saved") return "未提交";
  return verificationStatusLabel(status, verification);
}

function formatCompetitionRecordTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function renderPendingCompetitionRecord() {
  if (!pendingCompetitionRecord || !pendingCompetitionRecordTitle
    || !pendingCompetitionRecordSummary || !submitPendingRunRecordButton) return;
  const record = latestCompetitionRecord;
  let state = "empty";
  let title = "暂无待提交记录";
  let summary = "运行并结束一次比赛后，可在这里选择是否提交存档。";
  let showSubmit = false;

  if (running || competitionRunStartPending) {
    state = "running";
    title = "比赛正在运行";
    summary = "打开记录面板不会暂停计时；运行结束后可决定是否提交。";
  } else if (record && competitionRecordAlreadyArchived(record)) {
    state = "archived";
    title = "本次运行记录已存档";
    const submissionId = latestCompetitionSubmissionReceipt?.submissionId || "";
    summary = submissionId
      ? `提交编号 ${submissionId.slice(-8)}，可在下方最近记录中查看。`
      : "这条记录已存在于后台存档中。";
  } else if (record && recordMatchesActiveServerSession(record)) {
    state = "pending";
    title = competitionSubmissionInFlight ? "正在提交当前运行记录" : "当前运行记录待提交";
    const score = Number(record.result?.score);
    summary = `${record.taskName || record.taskId || "比赛任务"}${Number.isFinite(score) ? ` · ${score.toFixed(1)} 分` : ""}。只有你主动点击后才会写入比赛存档。`;
    showSubmit = true;
  } else if (record) {
    state = "local";
    title = "当前记录仅保存在本页面";
    summary = "这次运行没有可用的服务端场次，可导出或校验，但不能提交比赛存档。";
  }

  pendingCompetitionRecord.dataset.recordState = state;
  pendingCompetitionRecordTitle.textContent = title;
  pendingCompetitionRecordSummary.textContent = summary;
  submitPendingRunRecordButton.hidden = !showSubmit;
  submitPendingRunRecordButton.disabled = competitionSubmissionInFlight;
  submitPendingRunRecordButton.setAttribute("aria-busy", String(competitionSubmissionInFlight));
  const label = submitPendingRunRecordButton.querySelector("span");
  if (label) label.textContent = competitionSubmissionInFlight ? "正在提交" : "提交当前运行记录";
}

async function submitSavedCompetitionRecord(recordId, button = null) {
  if (!/^sub_[a-f0-9]{32}$/.test(recordId || "")) return false;
  const existing = competitionRecordSubmitOperations.get(recordId);
  if (existing) return existing;
  const operation = (async () => {
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      const label = button.querySelector("span");
      if (label) label.textContent = "正在提交";
    }
    if (competitionRecordsStatus) {
      competitionRecordsStatus.dataset.status = "loading";
      competitionRecordsStatus.textContent = `正在校验并提交记录 ${recordId.slice(-8)}…`;
    }
    try {
      const { response, payload } = await requestVerificationEndpoint(
        `${PERSONAL_RECORDS_ENDPOINT}/${encodeURIComponent(recordId)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        },
        RUN_RECORD_VERIFICATION_TIMEOUT_MS
      );
      if (!response.ok) {
        throw normalizeRecordServiceError(payload, `提交失败（HTTP ${response.status}）`);
      }
      if (!payload
        || payload.schemaVersion !== RECORD_SUBMIT_RECEIPT_SCHEMA_VERSION
        || payload.authoritative !== false
        || payload.recordState !== "submitted"
        || payload.recordId !== recordId
        || payload.submissionId !== recordId
        || typeof payload.duplicate !== "boolean"
        || !Number.isFinite(Date.parse(payload.submittedAt))
        || payload.verification?.schemaVersion !== "chenlong.verification-report/v1"
        || payload.verification?.authoritative !== false) {
        throw new Error("记录提交服务响应不兼容");
      }
      const isLatestDraft = recordId === latestCompetitionDraftRecordId
        && recordMatchesActiveServerSession(latestCompetitionRecord);
      if (isLatestDraft) {
        const verificationStatus = String(payload.verification.status || "submitted").toLowerCase();
        latestCompetitionSubmissionReceipt = {
          ...payload,
          recordRef: latestCompetitionRecord
        };
        setCompetitionSubmissionResult(
          verificationStatus,
          `已正式提交 ${recordId.slice(-8)} · ${verificationStatus} · authoritative: false`
        );
        setCompetitionRecordActionStatus(
          "submit",
          verificationStatus === "verified" ? "success" : "warning",
          `本次运行记录已正式提交：${recordId.slice(-8)}`
        );
        updateCompetitionSubmissionButton();
      }
      setStatus(`记录 ${recordId.slice(-8)} 已提交`);
      if (competitionRecordsStatus) {
        competitionRecordsStatus.dataset.status = "ready";
        competitionRecordsStatus.textContent = `记录 ${recordId.slice(-8)} 已完成校验并提交。`;
      }
      await loadCompetitionRecordsPreview();
      return true;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 120);
      if (competitionRecordsStatus) {
        competitionRecordsStatus.dataset.status = "error";
        competitionRecordsStatus.textContent = `记录提交失败：${message}`;
      }
      setStatus(`记录提交失败：${message}`);
      if (button?.isConnected) {
        button.disabled = false;
        button.setAttribute("aria-busy", "false");
        const label = button.querySelector("span");
        if (label) label.textContent = "提交";
      }
      return false;
    } finally {
      competitionRecordSubmitOperations.delete(recordId);
    }
  })();
  competitionRecordSubmitOperations.set(recordId, operation);
  return operation;
}

function renderCompetitionRecordsList(records) {
  if (!competitionRecordsList) return;
  competitionRecordsList.replaceChildren();
  if (!records.length) {
    if (competitionRecordsStatus) {
      competitionRecordsStatus.dataset.status = "empty";
      competitionRecordsStatus.textContent = "还没有自动保存的运行记录。";
    }
    return;
  }
  records.forEach(record => {
    const verification = record?.verification && typeof record.verification === "object"
      ? record.verification
      : {};
    const recomputed = verification.recomputedResult && typeof verification.recomputedResult === "object"
      ? verification.recomputedResult
      : {};
    const scoreValue = Number(record?.score ?? recomputed.score);
    const recordState = record?.recordState === "saved" ? "saved" : "submitted";
    const status = recordState === "saved"
      ? "saved"
      : String(record?.status ?? verification.status ?? "unknown").toLowerCase();
    const scope = verificationScopeSummary(verification);
    const item = document.createElement("article");
    item.className = "workspace-record-item";
    const recordId = String(record?.submissionId || record?.id || "");
    if (/^sub_[a-f0-9]{32}$/.test(recordId)) item.dataset.recordId = recordId;

    const identity = document.createElement("div");
    const task = document.createElement("strong");
    task.textContent = String(record?.taskName || record?.taskId || "未知任务").slice(0, 80);
    const meta = document.createElement("small");
    const shortId = recordId.slice(-8) || "未编号";
    const recordTime = recordState === "saved"
      ? record?.savedAt
      : record?.submittedAt || record?.receivedAt;
    meta.textContent = `${formatCompetitionRecordTime(recordTime)} · ${shortId}`;
    identity.append(task, meta);

    const score = document.createElement("span");
    score.className = "workspace-record-score";
    score.textContent = Number.isFinite(scoreValue) ? scoreValue.toFixed(1) : "—";

    const statusGroup = document.createElement("div");
    statusGroup.className = "workspace-record-verification";
    const badge = document.createElement("span");
    badge.className = "workspace-record-status";
    badge.dataset.status = status;
    badge.textContent = competitionRecordStatusLabel(status, verification);
    statusGroup.append(badge);
    if (status === "verified" && scope.visionStatus === "not_recomputed") {
      const hint = document.createElement("small");
      hint.className = "workspace-record-scope-hint";
      hint.textContent = "视觉未重算";
      statusGroup.append(hint);
    }
    const action = document.createElement("button");
    action.type = "button";
    action.className = "workspace-record-submit";
    const actionIcon = document.createElement("i");
    actionIcon.setAttribute("data-lucide", recordState === "saved" ? "send" : "circle-check-big");
    actionIcon.setAttribute("aria-hidden", "true");
    const actionLabel = document.createElement("span");
    const submitting = competitionRecordSubmitOperations.has(recordId);
    actionLabel.textContent = recordState === "saved"
      ? submitting ? "正在提交" : "提交"
      : "已提交";
    action.append(actionIcon, actionLabel);
    action.disabled = recordState !== "saved" || submitting;
    action.setAttribute("aria-busy", String(submitting));
    action.title = recordState === "saved" ? "校验并正式提交这条记录" : "这条记录已经提交";
    if (recordState === "saved") {
      action.addEventListener("click", () => { void submitSavedCompetitionRecord(recordId, action); });
    }
    item.append(identity, score, statusGroup, action);
    competitionRecordsList.append(item);
  });
  if (globalThis.lucide) globalThis.lucide.createIcons();
  if (competitionRecordsStatus) {
    competitionRecordsStatus.dataset.status = "ready";
    const savedCount = records.filter(record => record?.recordState === "saved").length;
    competitionRecordsStatus.textContent = `已显示最近 ${records.length} 条记录${savedCount ? `，其中 ${savedCount} 条待提交` : "，均已提交"}。`;
  }
}

function renderCompetitionTaskHighScores(records) {
  if (!competitionTaskHighScores) return;
  const taskIds = GUANGYANG_CHALLENGE_CONFIGS.map(config => config.taskId);
  const scores = PERSONAL_SCORE_RULES.buildSubmittedTaskScores(records, taskIds, COMPETITION_SCORE_MAXIMUM);
  competitionTaskHighScores.replaceChildren(...taskIds.map((taskId, index) => {
    const item = document.createElement("article");
    const label = document.createElement("span");
    const score = document.createElement("strong");
    label.textContent = `任务${index + 1}`;
    score.textContent = scores[taskId] === null ? "—" : `${Number(scores[taskId]).toFixed(1)} / 100`;
    item.append(label, score);
    return item;
  }));
}

async function loadCompetitionRecordsPreview() {
  if (!competitionRecordsStatus || !competitionRecordsList) return;
  const requestSerial = ++competitionRecordsRequestSerial;
  const abortController = new AbortController();
  competitionRecordsAbortController?.abort();
  competitionRecordsAbortController = abortController;
  competitionRecordsStatus.dataset.status = "loading";
  competitionRecordsStatus.textContent = "正在读取自动保存的运行记录…";
  refreshCompetitionRecordsButton && (refreshCompetitionRecordsButton.disabled = true);
  try {
    const { response, payload } = await requestVerificationEndpoint(
      `${PERSONAL_RECORDS_ENDPOINT}?limit=1000`,
      { method: "GET" },
      RUN_RECORD_VERIFICATION_TIMEOUT_MS,
      abortController.signal
    );
    if (requestSerial !== competitionRecordsRequestSerial || !competitionRecordsDialog?.open) return;
    if (!response.ok) throw new Error(payload?.error?.message || `记录读取失败（HTTP ${response.status}）`);
    if (!payload || payload.authoritative !== false || !Array.isArray(payload.records)) {
      throw new Error("比赛记录列表响应不兼容");
    }
    setVerificationServiceHealth("online");
    renderCompetitionTaskHighScores(payload.records);
    renderCompetitionRecordsList(payload.records.slice(0, 12));
  } catch (error) {
    if (requestSerial !== competitionRecordsRequestSerial || error?.name === "AbortError") return;
    competitionRecordsList.replaceChildren();
    renderCompetitionTaskHighScores([]);
    competitionRecordsStatus.dataset.status = "error";
    competitionRecordsStatus.textContent = `记录读取失败：${String(error?.message || error).slice(0, 120)}`;
  } finally {
    if (requestSerial === competitionRecordsRequestSerial) {
      if (competitionRecordsAbortController === abortController) competitionRecordsAbortController = null;
      if (refreshCompetitionRecordsButton) refreshCompetitionRecordsButton.disabled = false;
    }
  }
}

function closeCompetitionRecords() {
  competitionRecordsRequestSerial += 1;
  competitionRecordsAbortController?.abort();
  competitionRecordsAbortController = null;
  if (competitionRecordsDialog?.open) competitionRecordsDialog.close();
  recordsNavLink?.setAttribute("aria-expanded", "false");
  recordsNavLink?.focus?.();
}

function openCompetitionRecords(event) {
  event?.preventDefault?.();
  if (!competitionRecordsDialog) return;
  renderPendingCompetitionRecord();
  if (!competitionRecordsDialog.open) competitionRecordsDialog.showModal();
  recordsNavLink?.setAttribute("aria-expanded", "true");
  setStatus("已打开我的比赛记录，工作台保持运行");
  void loadCompetitionRecordsPreview();
}

function setCompetitionRunState(label, state = "idle") {
  if (!competitionRunState) return;
  competitionRunState.textContent = label;
  competitionRunState.dataset.state = state;
}

function competitionScoreWeights() {
  const configured = activeMission?.competition?.config?.scoring?.weights || {};
  return {
    task: Number(configured.task) || 40,
    rules: Number(configured.rules) || 25,
    autonomous: Number(configured.autonomous) || 15,
    efficiency: Number(configured.efficiency) || 20
  };
}

async function submitPendingCompetitionRecord() {
  await submitLatestCompetitionRecord();
  renderPendingCompetitionRecord();
}

function setCompetitionHudVisibility() {
  if (!competitionHud) return;
  const real = targetSelect?.value === "real";
  const visible = isCompetitionMission();
  const guangyangMap = activeMission?.environment === "guangyang";
  competitionHud.hidden = real || !visible;
  simulator?.classList.toggle("is-competition-map", guangyangMap);
  sceneTools?.classList.toggle("is-competition-locked", guangyangMap);
  if (toggleSceneTools) toggleSceneTools.hidden = guangyangMap;
  if (guangyangMap) {
    sceneTools?.classList.add("is-collapsed");
    toggleSceneTools?.classList.remove("is-active");
  }
  if (real || !visible) return;
  if (!competitionSession && !latestCompetitionRecord) {
    const weights = competitionScoreWeights();
    competitionScore.textContent = "--";
    setCompetitionRunState("等待运行", "idle");
    competitionTimer.textContent = "00:00.0";
    competitionTaskScore.textContent = `0.0 / ${weights.task}`;
    competitionRuleScore.textContent = `${weights.rules.toFixed(1)} / ${weights.rules}`;
    competitionAutoScore.textContent = `${weights.autonomous.toFixed(1)} / ${weights.autonomous}`;
    competitionEfficiencyScore.textContent = `0.0 / ${weights.efficiency}`;
    competitionLatestEvent.textContent = "规则与评分参数为可配置草案，等待正式任务书冻结。";
    competitionLatestEvent.classList.remove("is-violation");
    replayRunRecordButton.disabled = false;
    exportRunRecordButton.disabled = false;
    updateServerVerificationButton();
    updateCompetitionSubmissionButton();
  }
}

function renderCompetitionHud(score = null, force = false) {
  if (!competitionHud || competitionHud.hidden) return;
  const now = performance.now();
  if (!force && now - lastCompetitionHudAt < 80) return;
  lastCompetitionHudAt = now;
  const activeScore = score || (competitionSession?.status === "running" ? competitionSession.snapshot() : latestCompetitionRecord?.result);
  if (!activeScore) {
    setCompetitionHudVisibility();
    return;
  }
  const elapsedMs = competitionSession?.status === "running"
    ? competitionSession.elapsedMs()
    : (Number(activeScore.durationSeconds) || 0) * 1000;
  competitionScore.textContent = Number(activeScore.score || 0).toFixed(1);
  if (competitionBatchIsOpen() && activeCompetitionBatch?.uiState === "running") {
    activeCompetitionBatch.currentScore = Number(activeScore.score || 0);
    if (competitionBatchCurrentScore) {
      competitionBatchCurrentScore.textContent = competitionBatchScoreText(activeCompetitionBatch.currentScore, 1);
    }
  }
  if (rankedEvaluationIsOpen() && activeRankedEvaluation?.uiState === "running") {
    activeRankedEvaluation.currentScore = Number(activeScore.score || 0);
  }
  competitionTimer.textContent = formatCompetitionTime(elapsedMs);
  const weights = competitionScoreWeights();
  competitionTaskScore.textContent = `${Number(activeScore.taskScore || 0).toFixed(1)} / ${weights.task}`;
  competitionRuleScore.textContent = `${Number(activeScore.ruleScore || 0).toFixed(1)} / ${weights.rules}`;
  competitionAutoScore.textContent = `${Number(activeScore.autonomousScore || 0).toFixed(1)} / ${weights.autonomous}`;
  competitionEfficiencyScore.textContent = `${Number(activeScore.efficiencyScore || 0).toFixed(1)} / ${weights.efficiency}`;
  const runInProgress = competitionSession?.status === "running";
  setCompetitionRunState(
    runInProgress ? "计时运行中" : activeScore.reason === "completed" ? "任务完成" : "运行已结束",
    runInProgress ? "running" : activeScore.reason === "completed" ? "completed" : "finished"
  );
}

async function startCompetitionRun(sourceCode, expectedRunToken = runToken) {
  if (!isCompetitionMission() || !globalThis.CompetitionCore) return true;
  const rankedManaged = rankedEvaluationIsOpen();
  const practiceManaged = !rankedManaged && competitionBatchIsOpen();
  const managedActive = rankedManaged ? activeRankedEvaluation : practiceManaged ? activeCompetitionBatch : null;
  const batchLease = managedActive?.lease || null;
  if ((rankedManaged || practiceManaged) && !batchLease) {
    throw new Error(rankedManaged
      ? "筛选五局当前局尚未取得服务端租约"
      : "练习五局当前局尚未取得服务端租约");
  }
  if (batchLease && sourceCode !== managedActive.source) {
    const error = new Error(rankedManaged
      ? "运行源码与本赛季筛选锁定源码不一致"
      : "运行源码与本次练习锁定源码不一致");
    error.code = "SOURCE_LOCKED";
    throw error;
  }
  stopCompetitionReplay({ restoreButton: false });
  if (competitionSession?.status === "running") finishCompetitionRun("restarted");
  competitionSession = null;
  latestCompetitionRecord = null;
  exportRunRecordButton.disabled = false;
  replayRunRecordButton.disabled = false;
  resetCompetitionVerificationResult();
  setCompetitionRecordActionStatus(
    "record",
    "idle",
    batchLease
      ? rankedManaged
        ? "筛选五局运行中；本局结束后只会写入锁定的筛选局并按顺序推进"
        : "练习五局运行中（不入榜）；本局结束后将自动服务端验证并推进"
      : "比赛运行中；结束后会自动保存，也可回放、导出或校验"
  );
  resetCompetitionSubmissionState({
    clearSession: true,
    message: batchLease
      ? rankedManaged
        ? `筛选五局第 ${batchLease.slotIndex} 局已绑定 · 本地参考 · authoritative: false`
        : `练习五局第 ${batchLease.slotIndex} 局已绑定 · 不入榜 · authoritative: false`
      : "正在准备新的比赛场次… · authoritative: false"
  });
  let config = activeMission.competition.config;
  competitionLatestEvent.textContent = batchLease
    ? rankedManaged
      ? `正在启动筛选五局第 ${batchLease.slotIndex} 局；只使用已锁定租约，本模式不会降级为普通场次或纯本地运行。`
      : `正在启动练习五局第 ${batchLease.slotIndex} 局；结果不入榜，本模式不会降级为纯本地运行。`
    : "正在创建本地服务端场次；若服务不可用，将自动继续纯本地运行。";
  competitionLatestEvent.classList.remove("is-violation");
  const serverSession = batchLease ? null : await createCompetitionServerSession(config, {
    aiAutonomyMode: guangyangAiAutonomyMode
  });
  if (expectedRunToken !== runToken || stopRequested || !isCompetitionMission()) {
    resetCompetitionSubmissionState({
      clearSession: true,
      message: "场次准备已取消 · authoritative: false"
    });
    setCompetitionRecordActionStatus("record", "warning", "比赛场次准备已取消");
    return false;
  }
  if (serverSession) {
    const frozenConfig = guangyangConfigFromFrozenRunDefinition(
      serverSession.runDefinition,
      serverSession.challenge,
      serverSession.mapConfig
    );
    const frozenMission = guangyangMissionFromConfig(frozenConfig);
    frozenMission.aiAutonomyMode = serverSession.aiAutonomyMode === true;
    applyGuangyangAiAutonomyPresentation(frozenMission);
    installGuangyangMissionSnapshot(frozenMission, { preserveCamera: true });
    config = activeMission.competition.config;
    addLog(
      `本局已锁定管理员地图第 ${serverSession.mapConfig.revision} 版；${serverSession.aiAutonomyMode
        ? "对象道路锚点未下发，需使用摄像头识别。"
        : "教学导航锚点已下发。"}本局运行和判分不会被后续发布改变。`,
      true
    );
  }
  await ensureSimulationSceneReady();
  if (expectedRunToken !== runToken || stopRequested) return false;
  let simulatorCore;
  if (batchLease) {
    simulatorCore = new globalThis.CompetitionCore.DeterministicSimulator(
      batchLease.runDefinition.simulationDefinition
    );
    deterministicSimulator = simulatorCore;
    competitionSession = globalThis.CompetitionCore.createSession(config, {
      teamId: batchLease.session.teamId,
      runId: batchLease.session.runId,
      serverSessionId: batchLease.session.sessionId,
      challengeDigest: batchLease.session.challengeDigest,
      sourceCode,
      runDefinition: batchLease.runDefinition,
      simulationDefinition: batchLease.runDefinition.simulationDefinition,
      interactionDefinition: batchLease.runDefinition.interactionDefinition
    });
  } else if (serverSession) {
    simulatorCore = new globalThis.CompetitionCore.DeterministicSimulator(
      serverSession.runDefinition.simulationDefinition
    );
    deterministicSimulator = simulatorCore;
    competitionSession = globalThis.CompetitionCore.createSession(config, {
      teamId: serverSession.teamId,
      runId: serverSession.runId,
      serverSessionId: serverSession.sessionId,
      challengeDigest: serverSession.challengeDigest,
      sourceCode,
      runDefinition: serverSession.runDefinition,
      simulationDefinition: serverSession.runDefinition.simulationDefinition,
      interactionDefinition: serverSession.runDefinition.interactionDefinition
    });
    const createdRunDefinition = competitionSession.recorder.export().runDefinition;
    if (!jsonStructuresEqual(createdRunDefinition, serverSession.runDefinition)) {
      competitionSession = null;
      throw new Error("浏览器运行定义与服务端冻结定义不一致");
    }
  } else {
    simulatorCore = ensureDeterministicSimulator({ reset: true });
    const teamId = serverSession?.teamId || currentCompetitionTeamId();
    competitionSession = globalThis.CompetitionCore.createSession(config, {
      teamId,
      sourceCode,
      randomSeed: activeMission.competition.randomSeed ?? 0,
      simulationDefinition: simulatorCore.definition(),
      interactionDefinition: packageInteractionDefinition(),
      ...(globalThis.CompetitionCore.VISION_DEFINITION
        || globalThis.CompetitionCore.NAVIGATION_DEFINITION
        || globalThis.CompetitionCore.NAVIGATION_CONTROL_DEFINITION ? {
        runDefinition: {
          ...(globalThis.CompetitionCore.VISION_DEFINITION
            ? { visionDefinition: globalThis.CompetitionCore.VISION_DEFINITION }
            : {}),
          ...(globalThis.CompetitionCore.NAVIGATION_DEFINITION
            ? { navigationDefinition: globalThis.CompetitionCore.NAVIGATION_DEFINITION }
            : {}),
          ...(globalThis.CompetitionCore.NAVIGATION_CONTROL_DEFINITION
            ? { navigationControlDefinition: globalThis.CompetitionCore.NAVIGATION_CONTROL_DEFINITION }
            : {})
        }
      } : {}),
    });
  }
  clearTimeout(competitionTimeoutId);
  clearInterval(competitionSamplingIntervalId);
  beginSimulationVisionRun();
  const clientWatchdogMs = Math.max(30000, Math.max(1, Number(config.timeLimitSeconds) || 600) * 2000);
  competitionTimeoutId = setTimeout(() => {
    if (!competitionSession || competitionSession.status !== "running") return;
    recordCompetitionEvent("client_watchdog", { message: "页面运行时间异常过长，安全看门狗已停止程序" });
    stopRequested = true;
    pauseRequested = false;
    const record = finishCompetitionRun("client_watchdog");
    if (pendingPythonRun) cancelPythonCollection("client_watchdog");
    commitCompetitionRecord(record);
    setStatus("运行已被安全看门狗停止");
  }, clientWatchdogMs);
  // Deterministic telemetry is emitted by simulation steps and action boundaries.
  // A host timer must never insert records or consume the global sequence.
  competitionSamplingIntervalId = competitionSession.simulationDefinition
    ? null : setInterval(() => competitionTick(), 100);
  exportRunRecordButton.disabled = false;
  replayRunRecordButton.disabled = false;
  competitionLatestEvent.textContent = "20ms 固定步长与 100ms 仿真遥测基线已启动。";
  competitionLatestEvent.classList.remove("is-violation");
  competitionTick(true);
  renderCompetitionHud(null, true);
  updateCompetitionSubmissionButton();
  return true;
}

function competitionTick(forceRecord = false) {
  if (navigationVisualPlayback
    && navigationVisualPlayback.runToken === runToken
    && navigationVisualPlayback.simulator === deterministicSimulator
    && navigationVisualPlayback.missionBuildGeneration === missionBuildGeneration) return;
  if (!competitionSession) return;
  if (competitionSession.status === "timeout") {
    handleCompetitionTimeout(competitionSession.finalRecord);
    return;
  }
  if (competitionSession.status !== "running") return;
  const packageTelemetry = missionAttempt?.spec.type === "delivery" || missionAttempt?.spec.type === "composite"
    ? ensureMissionPackages().map((record, index, packages) => ({
        id: record.id,
        x: record.x,
        z: record.z,
        stackLevel: packageStackLevelForIndex(packages, index)
      }))
    : null;
  const virtualVision = window.CarVision?.getStatus?.();
  const virtualCameraFrameId = virtualVision?.source === "virtual"
    && virtualVision.fresh
    && virtualVision.frameId === latestVirtualCameraFrameId
    ? virtualVision.frameId
    : null;
  const result = competitionSession.sample({
    x: robotPose.x,
    z: robotPose.z,
    heading: robotPose.heading,
    speed: Math.abs(robotLinearSpeed),
    steering: robotSteering,
    tick: deterministicSimulator?.tick ?? null,
    cameraFrameId: virtualCameraFrameId,
    holding: heldPackageId,
    ...(packageTelemetry ? { packages: packageTelemetry } : {})
  }, { forceRecord });
  if (result.timedOut) {
    handleCompetitionTimeout(result.record);
    return;
  }
  renderCompetitionViolations(result.violations);
  consumeCompetitionTaskResult(result);
  const hudScore = competitionSession?.status === "running"
    ? result.score
    : latestCompetitionRecord?.result || result.record?.result || competitionSession?.finalRecord?.result || result.score;
  renderCompetitionHud(hudScore, forceRecord);
}

function renderCompetitionViolations(violations = []) {
  violations.forEach(violation => {
    const scoring = activeMission.competition.config.scoring || {};
    const eventPenalty = Number(scoring.penalties?.[violation.type] || 0);
    const durationRate = Number(scoring.continuousPenalties?.[violation.type]?.perSecond || 0);
    competitionLatestEvent.textContent = durationRate > 0
      ? `${violation.message}（事件 -${eventPenalty.toFixed(1)}，持续 -${durationRate.toFixed(2)}/秒）`
      : `${violation.message}（-${eventPenalty.toFixed(1)}）`;
    competitionLatestEvent.classList.add("is-violation");
    addLog(`规则事件：${violation.message}。`);
  });
}

function consumeCompetitionTaskResult(result) {
  if (!missionAttempt || !result?.taskState) return;
  applyMissionTaskState(result.taskState);
  (result.taskEvents || []).forEach(event => {
    if (event.type === "checkpoint") {
      markMissionCheckpointVisited(Number(event.index));
      addLog(`已通过导航点 ${Number(event.index) + 1}/${result.taskState.checkpointTotal}。`);
    } else if (event.type === "package_delivered") {
      const objectLabel = event.objectRole === "distractor" ? "混淆物" : "目标物";
      const destinationLabel = objectTaskDestinationLabel(event.destinationRole);
      addLog(`投放完成：${objectLabel}已进入${destinationLabel}。`);
    } else if (event.type === "package_delivery_revoked") {
      addLog("投放状态已撤销：物体离开了指定区域。");
    }
  });
  renderMissionProgress();
  if (result.taskState.finished && !missionAttempt.completed) {
    completeMissionAttempt({
      alreadySampled: true,
      deferCompetitionFinish: competitionFinishInProgress
    });
  }
}

function clearCompetitionTimers() {
  clearTimeout(competitionTimeoutId);
  clearInterval(competitionSamplingIntervalId);
  competitionTimeoutId = null;
  competitionSamplingIntervalId = null;
}

function commitCompetitionRecord(record) {
  if (!record) return latestCompetitionRecord;
  endSimulationVisionRun();
  const timeoutAlreadyShown = latestCompetitionRecord?.result?.reason === "timeout";
  const recordChanged = !latestCompetitionRecord || latestCompetitionRecord.runId !== record.runId;
  const draftSession = recordChanged && recordMatchesActiveServerSession(record)
    ? activeCompetitionServerSession
    : null;
  if (recordChanged) latestCompetitionRecord = record;
  clearCompetitionTimers();
  exportRunRecordButton.disabled = false;
  replayRunRecordButton.disabled = false;
  if (recordChanged) {
    resetCompetitionVerificationResult();
    setCompetitionRecordActionStatus(
      "record",
      "idle",
      draftSession
        ? "运行记录已就绪，正在自动保存到“我的比赛记录”"
        : "运行记录已就绪；可回放、导出或进行服务端校验"
    );
    resetCompetitionSubmissionState({
      message: draftSession
        ? "运行记录已就绪，正在自动保存 · 尚未正式提交"
        : "本次记录未绑定服务端场次，仅可本地导出/校验 · authoritative: false"
    });
    if (draftSession) void saveCompetitionRecordDraft(record, draftSession);
  } else {
    updateServerVerificationButton();
    updateCompetitionSubmissionButton();
  }
  if (competitionRecordsDialog?.open) renderPendingCompetitionRecord();
  renderCompetitionHud(latestCompetitionRecord.result, true);
  if (latestCompetitionRecord.result?.reason === "timeout") {
    stopRequested = true;
    pauseRequested = false;
    robotLinearSpeed = 0;
    robotSteering = 0;
    setStatus("比赛时间到");
    if (!timeoutAlreadyShown) addLog("比赛时间达到上限，本次运行已自动结束。");
  }
  return latestCompetitionRecord;
}

function handleCompetitionTimeout(record = null) {
  const finalRecord = record || competitionSession?.finalRecord || competitionSession?.finish("timeout");
  commitCompetitionRecord(finalRecord);
  stopRequested = true;
  pauseRequested = false;
  robotLinearSpeed = 0;
  robotSteering = 0;
  if (pendingPythonRun) cancelPythonCollection("timeout");
  return latestCompetitionRecord;
}

function recordCompetitionEvent(type, detail = {}) {
  if (!competitionSession || competitionSession.status !== "running") return;
  competitionSession.addEvent(type, detail);
}

function recordCompetitionManualInput(action, detail = {}) {
  if (!competitionSession || competitionSession.status !== "running") return null;
  const tick = deterministicSimulator?.tick;
  const inputDetail = {
    ...detail,
    ...(Number.isSafeInteger(tick) ? { tick } : {})
  };
  if (typeof competitionSession.addManualInput === "function") {
    return competitionSession.addManualInput(action, inputDetail);
  }
  return competitionSession.addEvent("manual_control", { action, ...inputDetail });
}

function recordCompetitionViolation(type, detail = {}, elapsedMsOverride = null) {
  if (!competitionSession || competitionSession.status !== "running") return null;
  if (elapsedMsOverride !== null && Number.isFinite(competitionSession.timeLimitMs)
    && Number(elapsedMsOverride) >= competitionSession.timeLimitMs) return null;
  const violation = elapsedMsOverride === null
    ? competitionSession.addViolation(type, detail)
    : competitionSession.recordViolation(type, detail, Number(elapsedMsOverride));
  if (!violation) return null;
  competitionLatestEvent.textContent = violation.message;
  competitionLatestEvent.classList.add("is-violation");
  renderCompetitionHud(null, true);
  return violation;
}

function finishCompetitionRun(reason = "finished") {
  if (!competitionSession) return latestCompetitionRecord;
  if (competitionSession.status !== "running") {
    return commitCompetitionRecord(competitionSession.finalRecord || latestCompetitionRecord);
  }
  competitionFinishInProgress = true;
  try {
    competitionTick(true);
    if (competitionSession.status !== "running") {
      return commitCompetitionRecord(competitionSession.finalRecord);
    }
    const finalReason = missionAttempt?.completed ? "completed" : reason;
    return commitCompetitionRecord(competitionSession.finish(finalReason));
  } finally {
    competitionFinishInProgress = false;
  }
}

async function exportLatestCompetitionRecord() {
  setCompetitionRecordActionStatus("export", "checking", "导出：正在准备运行记录…");
  const record = latestCompetitionRecord || await ensureLatestCompetitionRecord("导出");
  if (!record) return;
  const filename = `${record.runId || "competition-run"}.json`;
  try {
    const json = JSON.stringify(record, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    setStatus(`已生成运行记录下载：${filename}`);
    setCompetitionRecordActionStatus("export", "success", `导出完成：${filename}`);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 120);
    setStatus(`导出运行记录失败：${message}`);
    setCompetitionRecordActionStatus("export", "error", `导出失败：${message}`);
    addLog(`运行记录导出失败：${message}。`);
  }
}

function setReplayButtonState(active) {
  if (!replayRunRecordButton) return;
  replayRunRecordButton.classList.toggle("is-running", active);
  replayRunRecordButton.setAttribute("aria-pressed", String(active));
  const label = replayRunRecordButton.querySelector("span");
  if (label) label.textContent = active ? "停止回放" : "回放本次运行";
  const icon = replayRunRecordButton.querySelector("i, svg");
  if (icon?.tagName?.toLowerCase() === "i") icon.dataset.lucide = active ? "square" : "history";
  if (window.lucide) window.lucide.createIcons();
}

function stopCompetitionReplay({ restoreButton = true } = {}) {
  const cancelledLoad = cancelArchivedCompetitionRecordLoad();
  replayStopRequested = true;
  if (!replayRunning && restoreButton) {
    replayRunRecordButton?.setAttribute("aria-busy", "false");
    setReplayButtonState(false);
  }
  return cancelledLoad || replayRunning;
}

function applyReplayPackageFrame(frame, previousSignature = "") {
  const hasPackages = Array.isArray(frame?.packages);
  const hasHolding = Boolean(frame) && Object.prototype.hasOwnProperty.call(frame, "holding");
  if (!hasPackages && !hasHolding) return previousSignature;
  const interactionObjects = hasPackages
    ? frame.packages.flatMap(item => {
        const id = String(item?.id || "").trim();
        const x = Number(item?.x);
        const z = Number(item?.z);
        const stackLevel = Number(item?.stackLevel);
        if (!id || !Number.isFinite(x) || !Number.isFinite(z)) return [];
        const role = ["target", "distractor", "obstacle"].includes(String(item?.role))
          ? String(item.role)
          : "target";
        return [{
          id,
          role,
          x,
          z,
          stackLevel: Number.isSafeInteger(stackLevel) && stackLevel >= 0 ? stackLevel : 0
        }];
      })
    : ensureMissionPackages().map((record, index, records) => ({
        ...record,
        role: packageCategory(record) === "distractor" ? "distractor" : "target",
        stackLevel: packageStackLevelForIndex(records, index)
      }));
  const packages = interactionObjects.filter(item => item.role !== "obstacle");
  const holding = typeof frame?.holding === "string" && frame.holding.trim() ? frame.holding.trim() : null;
  const signature = JSON.stringify({
    holding,
    packages: interactionObjects.map(item => [item.id, item.role, item.x, item.z, item.stackLevel])
  });
  if (signature === previousSignature) return previousSignature;

  interactionObjects.filter(item => item.role === "obstacle").forEach(item => {
    const mesh = obstacleMeshes.find(candidate => candidate.userData.interactionObjectId === item.id);
    if (mesh) mesh.position.set(item.x, mesh.position.y, item.z);
  });
  activeMission.packages = packages
    .slice()
    .sort((left, right) => (
      packageStackKey(left.x, left.z).localeCompare(packageStackKey(right.x, right.z))
      || left.stackLevel - right.stackLevel
      || left.id.localeCompare(right.id)
    ))
    .map(item => ({
      id: item.id,
      x: item.x,
      z: item.z,
      category: item.role === "distractor" ? "混淆物" : "目标物"
    }));
  const packageIds = new Set(packages.map(item => item.id));
  packageMeshes.forEach(mesh => {
    mesh.visible = packageIds.has(mesh.userData.packageId);
  });
  packages.forEach((record, index) => {
    const visualRecord = {
      ...record,
      category: record.role === "distractor" ? "混淆物" : "目标物"
    };
    let mesh = packageMeshes.find(candidate => candidate.userData.packageId === record.id);
    if (!mesh) {
      addPackageMarker(visualRecord, record.stackLevel, index);
      mesh = packageMeshes[packageMeshes.length - 1];
    }
    mesh.visible = true;
    mesh.userData.stackLevel = record.stackLevel;
    mesh.userData.stackKey = packageStackKey(record.x, record.z);
    mesh.userData.packageIndex = index;
    if (record.id === holding && robotClaw) {
      if (mesh.parent !== robotClaw) {
        mesh.removeFromParent();
        robotClaw.add(mesh);
      }
      mesh.position.set(0, 0, -0.25);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(0.78 / 0.72, 0.78, 0.78);
      heldPackageId = record.id;
      heldPackageMesh = mesh;
    } else {
      if (mesh.parent !== scene) {
        mesh.removeFromParent();
        scene.add(mesh);
      }
      mesh.position.set(record.x, currentPackageBaseY() + record.stackLevel * PACKAGE_STACK_STEP, record.z);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.setScalar(1);
    }
  });
  if (!holding) {
    heldPackageId = null;
    heldPackageMesh = null;
  }
  if (robotClaw) robotClaw.scale.x = holding ? 0.72 : 1;
  if (robotArm) robotArm.rotation.x = 0;
  rebuildRobotCollisionShapes();
  markSceneShadowDirty();
  return signature;
}

function guangyangMissionFromFrozenRecord(record) {
  const runDefinition = record?.runDefinition;
  const taskDefinition = runDefinition?.taskDefinition;
  const simulationDefinition = runDefinition?.simulationDefinition;
  if (record?.schemaVersion !== "chenlong.run-record/v4"
    || record.mapId !== GUANGYANG_CONFIG?.mapId
    || !runDefinition || taskDefinition?.schemaVersion !== "chenlong.task/v5"
    || !(Number(simulationDefinition?.stepMs) > 0)
    || !Number.isSafeInteger(runDefinition.timeLimitTicks)) return null;
  const challenge = {
    taskId: record.taskId || taskDefinition.id,
    taskVersion: taskDefinition.version,
    mapId: record.mapId,
    mapVersion: record.mapVersion,
    ruleVersion: record.ruleVersion,
    displayName: record.taskName || GUANGYANG_CONFIG.displayName,
    timeLimitSeconds: runDefinition.timeLimitTicks * simulationDefinition.stepMs / 1000
  };
  return guangyangMissionFromConfig(
    guangyangConfigFromFrozenRunDefinition(
      runDefinition,
      challenge,
      null,
      { requireCurrentRuntime: false }
    )
  );
}

async function replayLatestCompetitionRecord() {
  if (replayRunning) {
    setCompetitionRecordActionStatus("replay", "warning", "正在停止回放…");
    stopCompetitionReplay();
    return;
  }
  if (replayRecordLoading) {
    cancelArchivedCompetitionRecordLoad();
    setStatus("已取消后台存档载入");
    setCompetitionRecordActionStatus("replay", "warning", "回放已取消：后台存档载入已停止");
    return;
  }
  setCompetitionRecordActionStatus("replay", "checking", "回放：正在准备运行记录…");
  if (running) {
    setStatus("请先停止当前 Python 程序再回放");
    setCompetitionRecordActionStatus("replay", "warning", "回放未开始：请先停止当前 Python 程序");
    return;
  }
  if (!latestCompetitionRecord) {
    replayRecordLoading = true;
    replayRunRecordButton.disabled = false;
    replayRunRecordButton.setAttribute("aria-busy", "true");
    const label = replayRunRecordButton.querySelector("span");
    if (label) label.textContent = "取消载入";
    setStatus("正在读取当前账户最近一次比赛存档…");
    setCompetitionRecordActionStatus("replay", "checking", "回放：正在读取最近一次比赛存档…");
    const loadOperation = loadLatestArchivedCompetitionRecord();
    replayRecordLoadOperation = loadOperation;
    try {
      const archivedRecord = await loadOperation;
      if (replayRecordLoadOperation !== loadOperation) return;
      if (!archivedRecord) {
        explainMissingCompetitionRecord("回放");
        return;
      }
      setStatus("后台存档已载入，正在准备回放");
      setCompetitionRecordActionStatus("replay", "checking", "回放：后台存档已载入，正在准备…");
    } catch (error) {
      if (error?.name === "AbortError" || replayRecordLoadOperation !== loadOperation) return;
      const message = String(error?.message || error).slice(0, 140);
      setStatus(`后台存档读取失败：${message}`);
      setCompetitionRecordActionStatus("replay", "error", `回放准备失败：${message}`);
      addLog(`回放准备失败：${message}。`);
      return;
    } finally {
      if (replayRecordLoadOperation === loadOperation) {
        replayRecordLoadOperation = null;
        replayRecordLoading = false;
        replayRunRecordButton.disabled = false;
        replayRunRecordButton.setAttribute("aria-busy", "false");
        setReplayButtonState(false);
      }
    }
  }
  if (running) {
    setStatus("请先停止当前 Python 程序再回放");
    setCompetitionRecordActionStatus("replay", "warning", "回放未开始：请先停止当前 Python 程序");
    return;
  }
  const Player = globalThis.CompetitionCore?.ReplayPlayer;
  if (!Player) {
    setStatus("回放核心尚未加载");
    setCompetitionRecordActionStatus("replay", "error", "回放失败：回放核心尚未加载");
    return;
  }
  let frozenReplayMission = null;
  try {
    frozenReplayMission = guangyangMissionFromFrozenRecord(latestCompetitionRecord);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 140);
    setStatus("运行记录的冻结地图无效");
    setCompetitionRecordActionStatus("replay", "error", `回放失败：${message}`);
    addLog(`回放失败：${message}。`);
    return;
  }
  const currentCompetition = activeMission?.competition?.config;
  if (!frozenReplayMission && latestCompetitionRecord.mapId
    && (!currentCompetition
      || latestCompetitionRecord.mapId !== currentCompetition.mapId
      || latestCompetitionRecord.mapVersion !== currentCompetition.mapVersion)) {
    setStatus("请先切回这份记录对应版本的比赛地图");
    setCompetitionRecordActionStatus("replay", "warning", "回放未开始：请切回记录对应版本的比赛地图");
    return;
  }
  const recordedTaskId = latestCompetitionRecord.taskId
    || latestCompetitionRecord.taskDefinition?.id
    || latestCompetitionRecord.runDefinition?.taskDefinition?.id;
  const recordedTaskVersion = latestCompetitionRecord.taskVersion
    || latestCompetitionRecord.taskDefinition?.version
    || latestCompetitionRecord.runDefinition?.taskDefinition?.version;
  if (!frozenReplayMission && (recordedTaskId || recordedTaskVersion)
    && (!currentCompetition
      || recordedTaskId !== currentCompetition.taskId
      || recordedTaskVersion !== currentCompetition.taskVersion)) {
    setStatus("这份记录使用旧版任务规则，当前页面不能直接回放");
    setCompetitionRecordActionStatus(
      "replay",
      "warning",
      "回放未开始：记录的任务版本与当前任务不一致，可在“我的比赛记录”中查看或导出"
    );
    return;
  }
  replayRunning = true;
  replayStopRequested = false;
  setReplayButtonState(true);
  replayRunRecordButton.disabled = false;
  replayRunRecordButton.setAttribute("aria-busy", "true");
  setCompetitionRecordActionStatus("replay", "checking", "回放：正在重建确定性轨迹…");
  await new Promise(resolve => setTimeout(resolve, 0));
  if (replayStopRequested) {
    replayRunning = false;
    replayStopRequested = false;
    replayRunRecordButton.setAttribute("aria-busy", "false");
    setReplayButtonState(false);
    setStatus("回放已停止");
    setCompetitionRecordActionStatus("replay", "warning", "回放已停止");
    return;
  }
  let player;
  let frames;
  try {
    player = new Player(latestCompetitionRecord);
    frames = player.trajectory();
  } catch (error) {
    replayRunning = false;
    replayStopRequested = false;
    replayRunRecordButton.disabled = false;
    replayRunRecordButton.setAttribute("aria-busy", "false");
    setReplayButtonState(false);
    setStatus("运行记录无法回放");
    setCompetitionRecordActionStatus("replay", "error", "回放失败：运行记录格式不兼容");
    addLog(`回放失败：${error.message || error}`);
    return;
  }
  if (frozenReplayMission) {
    installGuangyangMissionSnapshot(frozenReplayMission);
    addLog("回放已切换到该记录冻结的地图和任务定义；当前管理员地图不会改写旧记录。", true);
  }
  replayRunRecordButton.disabled = false;
  replayRunRecordButton.setAttribute("aria-busy", "false");
  if (!frames.length) {
    replayRunning = false;
    replayStopRequested = false;
    setReplayButtonState(false);
    setStatus("运行记录中没有可回放轨迹");
    setCompetitionRecordActionStatus("replay", "warning", "回放未开始：运行记录中没有轨迹");
    return;
  }
  replayPlayer = player;
  replayRunRecordButton.disabled = false;
  let previousFrame = null;
  let replayPackageSignature = "";
  try {
    restoreMissionBaseline();
    missionAttempt = null;
    resetRobot();
    rebuildSceneObjects();
    initializeMissionAttempt();
    replayStopRequested = false;
    resetTrajectory();
    clearActionLog();
    setCameraMode("follow");
    addLog(player.mode === "deterministic"
      ? "开始按固定步长重新执行本次控制输入。"
      : "旧版记录没有控制输入，正在按遥测样本播放。", true);
    setStatus(player.mode === "deterministic" ? "正在确定性回放 · 0%" : "正在播放遥测记录 · 0%");
    setCompetitionRecordActionStatus("replay", "checking", "回放进行中 · 0%");
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      if (replayStopRequested) break;
      const frame = frames[frameIndex];
      robotPose.x = Number(frame.x);
      robotPose.z = Number(frame.z);
      robotPose.heading = Number(frame.heading);
      robotLinearSpeed = Number(frame.linearSpeed) || 0;
      robotSteering = Number(frame.angularSpeed) || 0;
      replayPackageSignature = applyReplayPackageFrame(frame, replayPackageSignature);
      const replayCollision = frame?.collision
        || (Array.isArray(frame?.collisions) ? frame.collisions.at(-1) : null);
      const replayCollisionId = typeof replayCollision?.colliderId === "string"
        ? replayCollision.colliderId.trim()
        : "";
      const replayTaskCollisionChanged = replayCollisionId
        ? Boolean(missionAttempt?.taskEngine?.noteCollision?.(replayCollisionId))
        : false;
      if (previousFrame) {
        const distance = Math.hypot(frame.x - previousFrame.x, frame.z - previousFrame.z);
        if (distance > PHYSICS_EPSILON) {
          spinDriveWheels(distance * Math.sign(robotLinearSpeed || 1));
          addTrajectoryPoint(frame.x, frame.z);
        }
        const headingDelta = frame.heading - previousFrame.heading;
        if (Math.abs(headingDelta) > PHYSICS_EPSILON) spinTurnWheels(Math.sign(headingDelta), Math.abs(headingDelta) * 2.4);
      }
      syncRobot(undefined, { forceTelemetry: true });
      if (replayTaskCollisionChanged
        || Array.isArray(frame.packages)
        || Object.prototype.hasOwnProperty.call(frame, "holding")) {
        evaluateMissionProgress({ announce: false });
      }
      if (frameIndex === 0 || frameIndex === frames.length - 1 || frameIndex % 20 === 0) {
        const progress = Math.round(((frameIndex + 1) / frames.length) * 100);
        setStatus(`${player.mode === "deterministic" ? "正在确定性回放" : "正在播放遥测记录"} · ${progress}%`);
        setCompetitionRecordActionStatus("replay", "checking", `回放进行中 · ${progress}%`);
      }
      const delay = previousFrame ? Math.max(0, Number(frame.elapsedMs) - Number(previousFrame.elapsedMs)) / 2 : 0;
      previousFrame = frame;
      if (delay > 0) await sleep(Math.min(80, delay));
    }
    const verification = player.verify();
    if (replayStopRequested) {
      setStatus("回放已停止");
      setCompetitionRecordActionStatus("replay", "warning", "回放已停止");
      addLog("已停止本次运行回放。", true);
    } else if (player.mode === "telemetry"
      && latestCompetitionRecord.schemaVersion !== globalThis.CompetitionCore?.SCHEMA_VERSION) {
      setStatus("遥测回放完成（非确定性）");
      setCompetitionRecordActionStatus("replay", "warning", "遥测回放完成（非确定性）");
      addLog("旧版记录已按遥测播放；没有控制输入，不能做确定性校验。", true);
    } else if (verification.ok) {
      setStatus("确定性回放完成");
      setCompetitionRecordActionStatus("replay", "success", "确定性回放完成");
      addLog("回放完成：控制输入重算的车辆姿态与速度记录一致。", true);
    } else {
      setStatus("回放完成，记录存在差异");
      setCompetitionRecordActionStatus("replay", "error", "回放完成，但记录存在差异");
      addLog(`回放完成，但发现 ${verification.mismatches.length || verification.diagnostics.length} 处记录差异。`, true);
    }
  } catch (error) {
    const message = String(error?.message || error).slice(0, 140);
    setStatus(`回放中断：${message}`);
    setCompetitionRecordActionStatus("replay", "error", `回放中断：${message}`);
    addLog(`回放中断：${message}。`);
  } finally {
    replayRunning = false;
    replayStopRequested = false;
    robotLinearSpeed = 0;
    robotSteering = 0;
    setReplayButtonState(false);
    replayRunRecordButton.disabled = false;
    updateRobotTelemetry(undefined, true);
  }
}

function renderMissionInfo() {
  const missionTitle = document.querySelector("#missionTitle");
  const missionText = document.querySelector("#missionText");
  if (missionTitle) missionTitle.textContent = activeMission.title || "任务：自定义地图";
  if (missionText) missionText.textContent = activeMission.text || "使用 Python 控制小车完成场景目标。";
  syncGuangyangTrainingControls();
  syncTrainingVisionWorkbenchVisibility();
  renderObjectTrainingPanel();
}

function isGuangyangAiAutonomyMission(mission = activeMission) {
  return mission?.environment === "guangyang"
    && mission?.aiAutonomyMode === true
    && !isObjectTrainingMission(mission);
}

function applyGuangyangAiAutonomyPresentation(mission) {
  if (!mission || mission.environment !== "guangyang" || mission.aiAutonomyMode !== true) return mission;
  mission.title = "广阳岛 AI 自主挑战";
  mission.text = "道路图、任务目标和存放点公开；目标物、混淆物和障碍物位置不通过导航 API 下发。请用摄像头识别、任务状态和道路控制完成任务。";
  return mission;
}

function setGuangyangAiAutonomyMode(enabled) {
  const next = Boolean(enabled);
  if (running || competitionRunStartPending || replayRunning || isObjectTrainingMission()) return;
  if (guangyangAiAutonomyMode === next) return;
  guangyangAiAutonomyMode = next;
  if (activeMission?.environment === "guangyang") loadMission("guangyang");
  else syncGuangyangTrainingControls();
  setStatus(next
    ? "已启用 AI 自主挑战：运行时不会下发三类对象的道路锚点"
    : "已切回教学导航模式：可读取任务道路锚点");
}

function syncGuangyangTrainingControls() {
  const onGuangyang = activeMission?.environment === "guangyang";
  const training = isObjectTrainingMission();
  if (guangyangTrainingButton) {
    guangyangTrainingButton.hidden = !onGuangyang;
    guangyangTrainingButton.classList.toggle("is-active", training);
    guangyangTrainingButton.setAttribute("aria-pressed", String(training));
    const label = guangyangTrainingButton.querySelector("span");
    if (label) label.textContent = training ? "识别练习中" : "摄像头识别练习";
  }
  document.querySelectorAll("[data-view]").forEach(button => {
    const unavailable = isGuangyangAiAutonomyMission() && button.dataset.view !== "follow";
    button.disabled = unavailable;
    button.setAttribute("aria-disabled", String(unavailable));
  });
  document.querySelectorAll("[data-guangyang-training]").forEach(button => {
    const active = training && button.dataset.guangyangTraining === activeMission.objectTraining?.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function isObjectTrainingMission(mission = activeMission) {
  return mission?.environment === "guangyang"
    && mission?.trainingOnGuangyang === true
    && Boolean(mission?.objectTraining);
}

function virtualVisionLetterboxTransform(
  sourceWidth = VIRTUAL_CAMERA_WIDTH,
  sourceHeight = VIRTUAL_CAMERA_HEIGHT,
  modelSize = VIRTUAL_VISION_MODEL_SIZE
) {
  const width = Number(sourceWidth);
  const height = Number(sourceHeight);
  const size = Number(modelSize);
  if (!(width > 0 && height > 0 && size > 0)) return null;
  const scale = Math.min(size / width, size / height);
  const drawWidth = Math.round(width * scale);
  const drawHeight = Math.round(height * scale);
  return {
    sourceWidth: width,
    sourceHeight: height,
    modelSize: size,
    scale,
    padX: Math.floor((size - drawWidth) / 2),
    padY: Math.floor((size - drawHeight) / 2)
  };
}

function mapVirtualDetectionBoxToSource(
  box,
  sourceWidth = VIRTUAL_CAMERA_WIDTH,
  sourceHeight = VIRTUAL_CAMERA_HEIGHT,
  modelSize = VIRTUAL_VISION_MODEL_SIZE
) {
  const transform = virtualVisionLetterboxTransform(sourceWidth, sourceHeight, modelSize);
  if (!transform || !box) return null;
  const x = Number(box.x);
  const y = Number(box.y);
  const width = Number(box.width ?? box.w);
  const height = Number(box.height ?? box.h);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const unclippedLeft = (x - transform.padX) / transform.scale;
  const unclippedTop = (y - transform.padY) / transform.scale;
  const unclippedRight = (x + width - transform.padX) / transform.scale;
  const unclippedBottom = (y + height - transform.padY) / transform.scale;
  const left = Math.max(0, Math.min(transform.sourceWidth, unclippedLeft));
  const top = Math.max(0, Math.min(transform.sourceHeight, unclippedTop));
  const right = Math.max(0, Math.min(transform.sourceWidth, unclippedRight));
  const bottom = Math.max(0, Math.min(transform.sourceHeight, unclippedBottom));
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    leftPercent: left / transform.sourceWidth * 100,
    topPercent: top / transform.sourceHeight * 100,
    widthPercent: (right - left) / transform.sourceWidth * 100,
    heightPercent: (bottom - top) / transform.sourceHeight * 100
  };
}

function trainingVisionDetectionPresentation(detection, sourceWidth, sourceHeight) {
  const category = normalizeTrainingVisionCategory(detection?.category);
  const mappedBox = mapVirtualDetectionBoxToSource(detection?.box, sourceWidth, sourceHeight);
  if (!category || !mappedBox) return null;
  const confidenceValue = Number(detection?.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? `${Math.round(Math.max(0, Math.min(1, confidenceValue)) * 100)}%`
    : "置信度未知";
  const distanceValue = Number(detection?.distance);
  const distance = Number.isFinite(distanceValue) && distanceValue >= 0
    ? `${Math.round(worldUnitsToCm(distanceValue))} cm`
    : "距离未校准";
  return {
    category,
    categoryLabel: trainingVisionCategoryLabel(category),
    confidence,
    distance,
    box: mappedBox
  };
}

function clearTrainingVisionWorkbench(message = "等待虚拟摄像头画面", status = "empty") {
  if (!trainingVisionWorkbench) return;
  trainingVisionWorkbench.dataset.status = status;
  trainingVisionWorkbench.dataset.frameId = "";
  trainingVisionOverlay?.replaceChildren();
  if (trainingVisionCanvas) {
    const context = trainingVisionCanvas.getContext?.("2d");
    if (context) {
      context.setTransform?.(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, trainingVisionCanvas.width, trainingVisionCanvas.height);
    }
    trainingVisionCanvas.setAttribute("aria-label", "虚拟车载摄像头尚无画面");
  }
  if (trainingVisionEmpty) trainingVisionEmpty.hidden = false;
  if (trainingVisionFrameLabel) trainingVisionFrameLabel.textContent = "等待帧";
  if (trainingVisionStatus) trainingVisionStatus.textContent = message;
}

function syncTrainingVisionWorkbenchVisibility() {
  if (!trainingVisionWorkbench) return false;
  const visible = isObjectTrainingMission();
  trainingVisionWorkbench.hidden = !visible;
  trainingVisionWorkbench.dataset.sceneId = visible ? String(activeMission.objectTraining.type || "object-training") : "";
  if (!visible) clearTrainingVisionWorkbench();
  return visible;
}

function renderTrainingVisionWorkbenchFrame(sourceCanvas, detections, frameId) {
  if (!syncTrainingVisionWorkbenchVisibility()) return false;
  const visionStatus = window.CarVision?.getStatus?.();
  const normalizedFrameId = Number(frameId);
  const sourceWidth = Number(sourceCanvas?.width);
  const sourceHeight = Number(sourceCanvas?.height);
  if (!sourceCanvas || !(sourceWidth > 0 && sourceHeight > 0)
    || !Number.isFinite(normalizedFrameId)
    || visionStatus?.source !== "virtual" || !visionStatus?.fresh
    || Number(visionStatus.frameId) !== normalizedFrameId) {
    clearTrainingVisionWorkbench("等待当前练习场景的新画面");
    return false;
  }

  const previewContext = trainingVisionCanvas?.getContext?.("2d");
  if (!trainingVisionCanvas || !previewContext) {
    clearTrainingVisionWorkbench("摄像头预览画布不可用", "error");
    return false;
  }
  const deviceScale = Math.max(1, Math.min(
    TRAINING_VISION_PREVIEW_MAX_DPR,
    Number(window.devicePixelRatio) || 1
  ));
  const previewWidth = Math.max(1, Math.round(sourceWidth * deviceScale));
  const previewHeight = Math.max(1, Math.round(sourceHeight * deviceScale));
  if (trainingVisionCanvas.width !== previewWidth) trainingVisionCanvas.width = previewWidth;
  if (trainingVisionCanvas.height !== previewHeight) trainingVisionCanvas.height = previewHeight;
  previewContext.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
  previewContext.clearRect(0, 0, sourceWidth, sourceHeight);
  // The competition evidence canvas is read-only here. Detection boxes live in
  // the sibling DOM overlay and can never be encoded into recorded PNG frames.
  previewContext.drawImage(sourceCanvas, 0, 0, sourceWidth, sourceHeight);

  const presentations = (Array.isArray(detections) ? detections : [])
    .filter(detection => Number(detection?.frameId) === normalizedFrameId)
    .flatMap(detection => {
      const presentation = trainingVisionDetectionPresentation(detection, sourceWidth, sourceHeight);
      return presentation ? [presentation] : [];
    });
  const boxNodes = presentations.map(presentation => {
    const box = document.createElement("div");
    box.className = "training-vision-box";
    box.dataset.visionBox = "";
    box.dataset.category = presentation.category;
    box.dataset.frameId = String(normalizedFrameId);
    box.setAttribute("role", "listitem");
    box.setAttribute(
      "aria-label",
      `第 ${normalizedFrameId} 帧，${presentation.categoryLabel}，置信度 ${presentation.confidence}，距离 ${presentation.distance}`
    );
    box.style.left = `${presentation.box.leftPercent.toFixed(4)}%`;
    box.style.top = `${presentation.box.topPercent.toFixed(4)}%`;
    box.style.width = `${presentation.box.widthPercent.toFixed(4)}%`;
    box.style.height = `${presentation.box.heightPercent.toFixed(4)}%`;
    const label = document.createElement("span");
    label.textContent = `${presentation.categoryLabel} · ${presentation.confidence} · ${presentation.distance}`;
    box.append(label);
    return box;
  });
  trainingVisionOverlay?.replaceChildren(...boxNodes);
  trainingVisionWorkbench.dataset.status = "ready";
  trainingVisionWorkbench.dataset.frameId = String(normalizedFrameId);
  if (trainingVisionEmpty) trainingVisionEmpty.hidden = true;
  if (trainingVisionFrameLabel) trainingVisionFrameLabel.textContent = `帧 #${normalizedFrameId}`;
  if (trainingVisionStatus) {
    trainingVisionStatus.textContent = presentations.length
      ? `像素识别已标出 ${presentations.length} 个训练对象`
      : "当前画面没有识别到训练对象";
  }
  trainingVisionCanvas.setAttribute(
    "aria-label",
    `虚拟车载摄像头第 ${normalizedFrameId} 帧，识别到 ${presentations.length} 个训练对象`
  );
  return true;
}

function objectTrainingChecklistState(training, observedCategories, holdingCategory) {
  const delivered = Boolean(missionAttempt?.completed || missionAttempt?.deliveredPackageIds?.size);
  if (training?.type === "target-delivery") {
    return [observedCategories.has("target"), holdingCategory === "target" || delivered, delivered];
  }
  if (training?.type === "distractor-removal") {
    return [observedCategories.has("distractor"), holdingCategory === "distractor" || delivered, delivered];
  }
  if (training?.type === "obstacle-avoidance") {
    return [
      observedCategories.has("obstacle"),
      Number(missionAttempt?.nextCheckpointIndex) > 0 || Boolean(missionAttempt?.completed),
      Boolean(missionAttempt?.completed) && Number(missionAttempt?.trainingCollisionCount || 0) === 0
    ];
  }
  return [];
}

function objectTrainingFeedback(training, completed, holdingCategory) {
  const missionComplete = Boolean(missionAttempt?.completed);
  if (training?.type === "target-delivery") {
    if (missionComplete || completed[2]) {
      return { state: "success", message: "目标物已正确送入存放点。试着改写扫描方向或步数，再运行一次。" };
    }
    if (!completed[0]) {
      return { state: "ready", message: "先用 robot.observe(\"目标物\") 确认类别；观察结果不会提供坐标或对象编号。" };
    }
    if (holdingCategory === "target") {
      return { state: "progress", message: "夹取成功。旋转观察“存放点”，靠近后 release() 完成投放。" };
    }
    return { state: "progress", message: "已经识别目标物。用 approach() 靠近、grab() 夹取，再用 holding() 检查类别。" };
  }
  if (training?.type === "distractor-removal") {
    if (missionComplete || completed[2]) {
      return { state: "success", message: "混淆物已放到道路外，分类与道路清理流程正确。" };
    }
    if (!completed[0]) {
      return { state: "ready", message: "先精确观察“混淆物”，不要按颜色名称或对象编号猜测类别。" };
    }
    if (holdingCategory === "distractor") {
      return { state: "progress", message: "夹爪确认持有混淆物。用 road_state() 比较左右道路余量，把小车留在路内，再朝选定边界外释放。" };
    }
    return { state: "progress", message: "已经识别混淆物。靠近夹取后，用 holding() 确认没有误抓目标物。" };
  }
  if (training?.type === "obstacle-avoidance") {
    const collisions = Number(missionAttempt?.trainingCollisionCount || 0);
    if (collisions > 0) {
      return { state: "retry", message: `本次已碰撞 ${collisions} 次。请重置场景，观察障碍后扩大侧向绕行距离。` };
    }
    if (missionComplete || completed[2]) {
      return { state: "success", message: "已无碰撞通过全部导航点并抵达安全终点。" };
    }
    if (!completed[0]) {
      return { state: "ready", message: "先用 robot.observe(\"障碍物\") 查看方位与距离，再决定从哪一侧绕行。" };
    }
    const visited = Number(missionAttempt?.nextCheckpointIndex || 0);
    return {
      state: "progress",
      message: visited > 0
        ? `已安全通过 ${visited} 个导航点，保持与障碍物的间距并继续前往终点。`
        : "已观察到障碍物。用转向和分段前进走侧方路线，避免直接向前冲。"
    };
  }
  return { state: "ready", message: "先运行视觉观察，再根据反馈完成下一步。" };
}

function renderObjectTrainingPanel() {
  if (!objectTrainingPanel) return;
  const training = activeMission?.objectTraining;
  objectTrainingPanel.hidden = !training;
  missionCard?.classList.toggle("has-object-training", Boolean(training));
  if (!training) return;

  if (objectTrainingSummary) objectTrainingSummary.textContent = training.summary || "按类别完成物体任务";
  if (objectTrainingLegend) {
    objectTrainingLegend.replaceChildren(...(training.legend || []).map(item => {
      const badge = document.createElement("span");
      badge.className = "object-training-legend-item";
      badge.dataset.category = item.category;
      const swatch = document.createElement("i");
      swatch.style.setProperty("--object-color", item.color || "#94a3b8");
      swatch.setAttribute("aria-hidden", "true");
      badge.append(swatch, document.createTextNode(item.label || item.category));
      return badge;
    }));
  }

  const observations = (getVisionSnapshot()?.objects || [])
    .filter(object => isStableVisionObject(object))
    .flatMap(object => {
      const category = canonicalVisionCategory(object);
      return category ? [safeVisionObservation(object)] : [];
    });
  const observedCategories = missionAttempt?.observedTrainingCategories || new Set();
  observations.forEach(item => observedCategories.add(item.category));
  const holdingCategory = heldObjectCategory();
  if (objectTrainingHolding) objectTrainingHolding.textContent = trainingVisionCategoryLabel(holdingCategory) || "空";
  if (objectTrainingObservations) {
    const rows = observations.length ? observations.slice(0, 3).map(item => {
      const row = document.createElement("li");
      const distance = item.distanceCm == null ? "距离未校准" : `${item.distanceCm} cm`;
      row.textContent = `${trainingVisionCategoryLabel(item.category) || item.name} · ${item.direction} · ${distance}`;
      return row;
    }) : [Object.assign(document.createElement("li"), { textContent: "尚未观察到练习物体" })];
    objectTrainingObservations.replaceChildren(...rows);
  }

  if (objectTrainingChecklist) {
    const completed = objectTrainingChecklistState(training, observedCategories, holdingCategory);
    objectTrainingChecklist.replaceChildren(...(training.checklist || []).map((label, index) => {
      const item = document.createElement("li");
      item.dataset.complete = String(Boolean(completed[index]));
      item.textContent = label;
      return item;
    }));
    const feedback = objectTrainingFeedback(training, completed, holdingCategory);
    if (objectTrainingCoach) objectTrainingCoach.dataset.state = feedback.state;
    if (objectTrainingCoachMessage) objectTrainingCoachMessage.textContent = feedback.message;
  }
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

function setCompetitionHudCollapsed(collapsed, { persist = true } = {}) {
  if (!competitionHud || !competitionHudBody || !competitionHudToggle) return;
  const isCollapsed = Boolean(collapsed);
  const actionLabel = isCollapsed ? "展开实时评测详情" : "收起实时评测详情";
  competitionHud.classList.toggle("is-collapsed", isCollapsed);
  competitionHudBody.hidden = isCollapsed;
  competitionHudBody.inert = isCollapsed;
  competitionHudToggle.setAttribute("aria-expanded", String(!isCollapsed));
  competitionHudToggle.setAttribute("aria-label", actionLabel);
  competitionHudToggle.title = actionLabel;
  const label = competitionHudToggle.querySelector("span");
  if (label) label.textContent = isCollapsed ? "展开详情" : "收起详情";
  if (persist) {
    try {
      localStorage.setItem("chenlongCompetitionHudCollapsed", isCollapsed ? "1" : "0");
    } catch {}
  }
}

function initCompetitionHudToggle() {
  if (!competitionHudToggle) return;
  let collapsed = true;
  try {
    collapsed = localStorage.getItem("chenlongCompetitionHudCollapsed") !== "0";
  } catch {}
  setCompetitionHudCollapsed(collapsed, { persist: false });
  competitionHudToggle.addEventListener("click", () => {
    setCompetitionHudCollapsed(!competitionHud.classList.contains("is-collapsed"));
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
  if (spec?.checkpointSource === "competition") {
    return (activeMission.competition?.config?.checkpoints || []).map(checkpoint => [...checkpoint.position]);
  }
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
  const supportedTypes = new Set(["auto", "delivery", "offroad-removal", "reach", "checkpoints", "composite", "practice"]);
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
    checkpointRadius: Math.max(0.1, Math.min(5, finiteNumber(configured.checkpointRadius, 0.78)))
  };
}

function createMissionTaskEngine(spec, packages, checkpointPoints) {
  const TaskEngine = globalThis.CompetitionCore?.TaskEngine;
  if (!TaskEngine) return null;
  // The local training completion type is evaluated below with the exact v5
  // road-clearance geometry. It is not a public TaskEngine task type.
  if (spec.type === "offroad-removal") return null;
  const competitionConfig = activeMission.competition?.config;
  const checkpoints = checkpointPoints.map((position, index) => ({
    id: competitionConfig?.checkpoints?.[index]?.id || `checkpoint-${index + 1}`,
    label: competitionConfig?.checkpoints?.[index]?.label || `checkpoint-${index + 1}`,
    position: [...position]
  }));
  const definition = {
    ...(spec.type === "composite" ? { schemaVersion: spec.schemaVersion || "chenlong.task/v5" } : {}),
    id: competitionConfig?.taskId || activeMission.title || "mission",
    version: competitionConfig?.taskVersion || "local-mission/v1",
    type: spec.type,
    checkpointRadius: spec.checkpointRadius,
    goalRadius: spec.goalRadius,
    deliveryRadius: spec.deliveryRadius
  };
  if (["checkpoints", "reach", "delivery", "composite"].includes(spec.type)) definition.goal = activeMission.goal ? [...activeMission.goal] : null;
  if (spec.type === "checkpoints" || spec.type === "composite") definition.checkpoints = checkpoints;
  if (spec.type === "delivery") {
    const availableIds = new Set(packages.map(record => record.id));
    const configuredIds = Array.isArray(spec.requiredPackageIds)
      ? spec.requiredPackageIds.map(String).filter(id => availableIds.has(id))
      : [];
    definition.requiredPackageIds = configuredIds.length ? configuredIds : [...availableIds];
  }
  if (spec.type === "composite") {
    definition.deliveries = structuredClone(spec.deliveries || []);
    if (definition.schemaVersion === "chenlong.task/v5") {
      definition.placementGeometry = structuredClone(spec.placementGeometry || {
        roads: (competitionConfig?.roads || currentGuangyangSceneConfig()?.roads || []).map(road => ({
          id: String(road.id),
          width: Number(road.width),
          points: (road.points || []).map(point => [Number(point[0]), Number(point[1])])
        }))
      });
    }
    if (definition.schemaVersion === "chenlong.task/v3"
      || definition.schemaVersion === "chenlong.task/v4"
      || definition.schemaVersion === "chenlong.task/v5") {
      definition.avoidanceObjectIds = Array.isArray(spec.avoidanceObjectIds)
        ? spec.avoidanceObjectIds.map(String)
        : [];
    }
  }
  return new TaskEngine(definition);
}

function applyMissionTaskState(state) {
  if (!missionAttempt || !state) return;
  missionAttempt.taskState = structuredClone(state);
  missionAttempt.nextCheckpointIndex = Number(state.nextCheckpointIndex) || 0;
  missionAttempt.goalReached = Boolean(state.goalReached);
  missionAttempt.deliveredPackageIds = new Set(state.deliveredPackageIds || []);
  missionAttempt.deliveryProgress = structuredClone(state.deliveryProgress || []);
  missionAttempt.avoidanceProgress = state.avoidanceProgress
    ? structuredClone(state.avoidanceProgress)
    : null;
}

function initializeMissionAttempt() {
  const spec = resolveMissionCompletionSpec();
  const packages = ensureMissionPackages();
  const checkpointPoints = spec.type === "checkpoints" || spec.type === "composite"
    ? getMissionCheckpointPositions(spec)
    : [];
  const taskEngine = createMissionTaskEngine(spec, packages, checkpointPoints);
  const availablePackageIds = new Set(packages.map(record => record.id));
  const configuredRequiredPackageIds = Array.isArray(spec.requiredPackageIds)
    ? spec.requiredPackageIds.map(String).filter(id => availablePackageIds.has(id))
    : [];
  const requiredPackageIds = taskEngine?.config?.requiredPackageIds
    || (configuredRequiredPackageIds.length ? configuredRequiredPackageIds : [...availablePackageIds]);
  missionAttempt = {
    spec,
    taskEngine,
    taskState: taskEngine?.snapshot() || null,
    completed: false,
    requiredPackageIds: new Set(requiredPackageIds),
    deliveredPackageIds: new Set(),
    roadClearanceHandledPackageIds: new Set(),
    deliveryProgress: [],
    avoidanceProgress: null,
    checkpointPoints,
    nextCheckpointIndex: 0,
    goalReached: false,
    trainingCollisionCount: 0,
    collisionFailureAnnounced: false,
    observedTrainingCategories: new Set(),
    lastUiSignature: ""
  };
  applyMissionTaskState(missionAttempt.taskState);
  evaluateMissionProgress({ allowComplete: true, announce: false });
}

function missionProgressSnapshot() {
  if (!missionAttempt) return { completed: 0, total: 0, label: "任务进度", value: "--", hint: "正在准备任务" };
  const { spec } = missionAttempt;
  if (spec.type === "practice") {
    return { completed: 0, total: 0, label: "练习模式", value: "自由", hint: "当前场景没有强制完成条件" };
  }
  if (spec.type === "offroad-removal") {
    const total = missionAttempt.requiredPackageIds.size;
    const completed = missionAttempt.deliveredPackageIds.size;
    const holding = heldPackageId && missionAttempt.requiredPackageIds.has(heldPackageId);
    const hint = holding
      ? "保持小车在道路内侧，把混淆物释放到任意道路边界外"
      : completed < total
        ? "夹取混淆物并把整个物体移出道路边界"
        : "混淆物已安全移出道路";
    return { completed, total, label: "道路清理", value: `${completed}/${total}`, hint };
  }
  if (spec.type === "composite") {
    const deliveryProgress = Array.isArray(missionAttempt.deliveryProgress) ? missionAttempt.deliveryProgress : [];
    const deliveryTotal = deliveryProgress.reduce((sum, item) => sum + (Number(item.total) || 0), 0)
      || (Array.isArray(spec.deliveries)
        ? spec.deliveries.reduce((sum, item) => sum + (item.requiredPackageIds?.length || 0), 0)
        : missionAttempt.requiredPackageIds.size);
    const deliveryCompleted = deliveryProgress.reduce((sum, item) => sum + (Number(item.completed) || 0), 0)
      || missionAttempt.deliveredPackageIds.size;
    const checkpointTotal = missionAttempt.checkpointPoints.length;
    const checkpointCompleted = Math.min(checkpointTotal, missionAttempt.nextCheckpointIndex);
    const returnCompleted = missionAttempt.goalReached ? 1 : 0;
    const avoidanceProgress = missionAttempt.avoidanceProgress || {};
    const avoidanceTotal = Math.max(0, Number(avoidanceProgress.total) || 0);
    const avoidanceCompleted = Math.max(0, Math.min(avoidanceTotal, Number(avoidanceProgress.completed) || 0));
    const avoidanceFailed = Array.isArray(avoidanceProgress.failedObjectIds)
      ? avoidanceProgress.failedObjectIds.length
      : 0;
    const total = deliveryTotal + checkpointTotal + 1 + avoidanceTotal;
    const completed = deliveryCompleted + checkpointCompleted + returnCompleted + avoidanceCompleted;
    const pendingDelivery = deliveryProgress.find(item => !item.finished);
    const pendingDestination = objectTaskDestinationLabel(pendingDelivery?.destinationRole);
    const pendingObject = pendingDelivery?.objectRole === "distractor" ? "混淆物" : "目标物";
    const hint = avoidanceFailed > 0
      ? `障碍绕行失败：已碰撞 ${avoidanceFailed} 个指定障碍物，请重置后重新比赛`
      : deliveryCompleted < deliveryTotal
        ? `把${pendingObject}投放到${pendingDestination}`
        : checkpointCompleted < checkpointTotal
          ? `前往巡检点 ${checkpointCompleted + 1}/${checkpointTotal}`
          : !returnCompleted
            ? "全部投放与巡检已完成，绕开障碍并返回停车区"
            : avoidanceTotal > 0 && avoidanceCompleted < avoidanceTotal
              ? "返航完成，但障碍绕行目标尚未通过"
              : avoidanceTotal > 0
                ? "两项投放、障碍绕行、四处巡检与返航均已完成"
                : "两项投放、四处巡检与返航均已完成";
    return {
      completed,
      total,
      label: "综合任务进度",
      value: `${completed}/${total}`,
      hint,
      composite: {
        deliveryCompleted,
        deliveryTotal,
        avoidanceCompleted,
        avoidanceTotal,
        avoidanceFailed,
        checkpointCompleted,
        checkpointTotal,
        returnCompleted
      }
    };
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
  if (spec.type === "checkpoints") {
    const checkpointTotal = missionAttempt.checkpointPoints.length;
    const total = checkpointTotal + 1;
    const collisionInvalid = activeMission.objectTraining?.type === "obstacle-avoidance"
      && Number(missionAttempt.trainingCollisionCount || 0) > 0;
    const rawCompleted = missionAttempt.nextCheckpointIndex + (missionAttempt.goalReached ? 1 : 0);
    const completed = collisionInvalid && missionAttempt.goalReached
      ? Math.min(rawCompleted, Math.max(0, total - 1))
      : rawCompleted;
    const hint = missionAttempt.nextCheckpointIndex < checkpointTotal
      ? `前往导航点 ${missionAttempt.nextCheckpointIndex + 1}`
      : collisionInvalid
        ? `已碰撞 ${missionAttempt.trainingCollisionCount} 次，请重置后重新绕行`
      : missionAttempt.goalReached
        ? "已通过导航点并抵达终点"
        : "导航点已通过，继续前往终点";
    return {
      completed,
      total,
      label: activeMission.theme === "maze" ? "迷宫路线" : "路线进度",
      value: collisionInvalid && missionAttempt.goalReached
        ? `碰撞 ${missionAttempt.trainingCollisionCount} 次 · 需重试`
        : `${missionAttempt.nextCheckpointIndex}/${checkpointTotal} · 终点${missionAttempt.goalReached ? "✓" : "○"}`,
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
  const snapshot = missionProgressSnapshot();
  renderObjectTrainingPanel();
  const signature = JSON.stringify({ ...snapshot, done: missionAttempt?.completed || false });
  if (missionAttempt && missionAttempt.lastUiSignature === signature) return;
  if (missionAttempt) missionAttempt.lastUiSignature = signature;
  if (missionProgressLabel) missionProgressLabel.textContent = missionAttempt?.completed ? "任务完成" : snapshot.label;
  if (missionProgressValue) missionProgressValue.textContent = missionAttempt?.completed ? "完成" : snapshot.value;
  if (missionProgressHint) missionProgressHint.textContent = missionAttempt?.completed ? "做得好！可以重置任务或选择下一项任务" : snapshot.hint;
  if (missionCompositeProgress) {
    const composite = snapshot.composite || null;
    missionCompositeProgress.hidden = !composite;
    if (composite) {
      missionCompositeProgress.dataset.objectives = composite.avoidanceTotal > 0 ? "4" : "3";
      if (missionDeliveryProgress) {
        missionDeliveryProgress.textContent = `${composite.deliveryCompleted}/${composite.deliveryTotal}`;
        missionDeliveryProgress.parentElement.dataset.complete = String(composite.deliveryCompleted >= composite.deliveryTotal);
      }
      if (missionAvoidanceProgress) {
        const avoidanceCell = missionAvoidanceProgress.parentElement;
        avoidanceCell.hidden = composite.avoidanceTotal <= 0;
        avoidanceCell.dataset.complete = String(
          composite.avoidanceTotal > 0 && composite.avoidanceCompleted >= composite.avoidanceTotal
        );
        avoidanceCell.dataset.failed = String(composite.avoidanceFailed > 0);
        missionAvoidanceProgress.textContent = composite.avoidanceFailed > 0
          ? "失败"
          : composite.avoidanceCompleted >= composite.avoidanceTotal && composite.avoidanceTotal > 0
            ? "✓"
            : "○";
      }
      if (missionCheckpointProgress) {
        missionCheckpointProgress.textContent = `${composite.checkpointCompleted}/${composite.checkpointTotal}`;
        missionCheckpointProgress.parentElement.dataset.complete = String(composite.checkpointCompleted >= composite.checkpointTotal);
      }
      if (missionReturnProgress) {
        missionReturnProgress.textContent = composite.returnCompleted ? "✓" : "○";
        missionReturnProgress.parentElement.dataset.complete = String(Boolean(composite.returnCompleted));
      }
    }
  }
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

function completeMissionAttempt({ alreadySampled = false, deferCompetitionFinish = false } = {}) {
  if (!missionAttempt || missionAttempt.completed) return;
  missionAttempt.completed = true;
  robotLinearSpeed = 0;
  robotSteering = 0;
  const competitionRecord = deferCompetitionFinish
    ? null
    : alreadySampled && competitionSession?.status === "running"
      ? commitCompetitionRecord(competitionSession.finish("completed"))
      : finishCompetitionRun("completed");
  if (competitionRecord?.result?.reason === "timeout") {
    handleCompetitionTimeout(competitionRecord);
    return;
  }
  renderMissionProgress();
  setStatus("任务完成");
  addLog("任务完成：当前场景已经满足全部目标。");
  if (running) {
    missionCompletionStopRequested = true;
    stopRequested = true;
    pauseRequested = false;
    if (isCompetitionMission()) {
      setTimeout(() => {
        if (running && missionAttempt?.completed) cancelPythonCollection("completed");
      }, 0);
    }
  }
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
  if (isCompetitionMission() && competitionSession && !replayRunning) {
    renderMissionProgress();
    return Boolean(missionAttempt.completed);
  }
  if (missionAttempt.spec.type === "offroad-removal") {
    const roads = missionAttempt.spec.placementRule === "road-edge-clearance"
      && Array.isArray(missionAttempt.spec.placementGeometry?.roads)
      ? missionAttempt.spec.placementGeometry.roads
      : [];
    const roadBoundaryClearance = globalThis.CompetitionCore?.geometry?.roadBoundaryClearance;
    const minimumClearance = Math.max(0, Number(missionAttempt.spec.minimumRoadEdgeClearance) || 0);
    const objectRadius = Math.max(0, Number(missionAttempt.spec.objectRadius) || 0);
    const packages = ensureMissionPackages();
    const deliveredIds = new Set();
    if (heldPackageId && missionAttempt.requiredPackageIds.has(heldPackageId)) {
      missionAttempt.roadClearanceHandledPackageIds.add(heldPackageId);
    }
    if (typeof roadBoundaryClearance === "function" && roads.length) {
      missionAttempt.requiredPackageIds.forEach(id => {
        const record = packages.find(item => item.id === id);
        if (!record || heldPackageId === id
          || !missionAttempt.roadClearanceHandledPackageIds.has(id)) return;
        const clearance = roadBoundaryClearance([record.x, record.z], roads, objectRadius);
        if (Number(clearance?.clearance) + PHYSICS_EPSILON >= minimumClearance) deliveredIds.add(id);
      });
    }
    const newlyDelivered = [...deliveredIds].some(id => !missionAttempt.deliveredPackageIds.has(id));
    missionAttempt.deliveredPackageIds = deliveredIds;
    const complete = deliveredIds.size > 0 && deliveredIds.size === missionAttempt.requiredPackageIds.size;
    renderMissionProgress();
    if (newlyDelivered && announce) addLog("道路清理完成：混淆物已完整移出道路边界。");
    if (complete && allowComplete) {
      if (replayRunning) {
        missionAttempt.completed = true;
        renderMissionProgress();
      } else completeMissionAttempt();
    }
    return complete;
  }
  const taskEngine = missionAttempt.taskEngine;
  if (!taskEngine) {
    renderMissionProgress();
    return false;
  }
  const result = taskEngine.evaluate({
    x: robotPose.x,
    z: robotPose.z,
    holding: heldPackageId,
    packages: ensureMissionPackages().map(record => ({ id: record.id, x: record.x, z: record.z }))
  }, performance.now());
  applyMissionTaskState(result.state);
  result.events.forEach(event => {
    if (event.type === "checkpoint") {
      markMissionCheckpointVisited(Number(event.index));
      if (announce) addLog(`已通过导航点 ${Number(event.index) + 1}/${result.state.checkpointTotal}。`);
    } else if (event.type === "package_delivered" && announce) {
      const objectLabel = event.objectRole === "distractor" ? "混淆物" : "目标物";
      const destinationLabel = objectTaskDestinationLabel(event.destinationRole);
      addLog(`投放完成：${objectLabel}已进入${destinationLabel}。`);
    } else if (event.type === "package_delivery_revoked" && announce) {
      addLog("投放状态已撤销：物体离开了指定区域。");
    }
  });
  const collisionInvalid = activeMission.objectTraining?.type === "obstacle-avoidance"
    && Number(missionAttempt.trainingCollisionCount || 0) > 0;
  const complete = Boolean(result.state.finished) && !collisionInvalid;
  renderMissionProgress();
  if (result.state.finished && collisionInvalid && !missionAttempt.collisionFailureAnnounced) {
    missionAttempt.collisionFailureAnnounced = true;
    setStatus("绕障训练需重试");
    if (announce) addLog("绕障路线已走完，但本次发生过碰撞。请重置任务后无碰撞完成。");
  }
  if (complete && allowComplete) {
    if (replayRunning) {
      missionAttempt.completed = true;
      renderMissionProgress();
    } else completeMissionAttempt();
  }
  return complete;
}

const EXAMPLE_PROGRAMS = {
  square: `# 让小车走一个边长 50 厘米的正方形
for _ in range(4):
    robot.forward(50)
    robot.right_angle(90)`,
  "road-sensor": `# 广阳岛：用任务锚点、道路拓扑和道路控制自行选择路线
mission = robot.mission()
graph = robot.map_graph()
pose = robot.odometry()
road = robot.road_state()
progress = robot.task_state()
print("当前地图：", mission["mapVersion"])
print("下一个途径点：", progress["nextCheckpointId"])
print("存放点道路锚点：", mission["storage"])
print("拓扑节点：", len(graph["nodes"]), "道路：", len(graph["edges"]))
print("相对起点：", pose)
print("当前道路：", road)

# 系统只列出合法出口，不会替程序推荐、选择或规划路线。
if road["atNode"]:
    print("当前可选出口：")
    for item in road["exits"]:
        print(item["roadId"], item["direction"], item["turnDeg"])
else:
    result = robot.follow_road(100, 30)
    print("循路结果：", result)`,
  "ai-autonomy": `# 广阳岛 AI 自主感知巡检（起步示例）
# 载入本示例会打开“AI 自主挑战”：mission 不提供物体道路锚点。
# 小车只使用摄像头、地图拓扑、道路状态和道路控制；没有写死坐标、秒数路线或转角路线。
# 它会优先巡检尚未走过的道路，记录真实识别结果，并在障碍物前安全停下。
# 下一步可在 seen 结果上加入“抓取 -> 去存放点 -> release_preview 确认投放”的策略。

mission = robot.mission()
graph = robot.map_graph()
progress = robot.task_state()

if mission["objects"]:
    raise RuntimeError("请先从示例载入本程序，或手动开启 AI 自主挑战")

edges = {edge["roadId"]: edge for edge in graph["edges"]}
visited_roads = set()
blocked_roads = set()
seen = {}

def scan_camera():
    # 只信任真实摄像头返回的类别、方向、距离和置信度。
    for label in ("目标物", "混淆物", "障碍物"):
        observation = robot.observe(label, 0.60)
        if observation:
            seen[label] = observation
            print("识别到", label, observation["direction"], observation["distanceCm"], "cm")
    return seen

def at_node():
    # 不用计时猜位置：循路直到道路传感器确认一个图节点。
    for _ in range(12):
        state = robot.road_state()
        if state["atNode"]:
            return state
        result = robot.follow_road(500, 40, True)
        if result["stoppedBy"] in ("junction", "road_end"):
            state = robot.road_state()
            if state["atNode"]:
                return state
            # 仅处理已知的节点判定边缘：一次低速前探后立即复核。
            robot.forward(2)
            state = robot.road_state()
            if state["atNode"]:
                return state
        elif result["stoppedBy"] == "front_clearance":
            scan_camera()
            raise RuntimeError("到节点前发现物体，请根据摄像头结果更新策略")
        elif result["stoppedBy"] != "max_distance":
            raise RuntimeError("道路控制被安全停止：" + result["stoppedBy"])
    raise RuntimeError("未能在道路控制预算内抵达节点")

def choose_unseen_exit(state):
    # 系统只给合法出口；哪条优先由本程序按照“未走过、字典序稳定”决定。
    options = [item["roadId"] for item in state["exits"]
               if item["roadId"] not in visited_roads and item["roadId"] not in blocked_roads]
    return sorted(options)[0] if options else None

def inspect_road(road_id):
    state = at_node()
    legal = {item["roadId"] for item in state["exits"]}
    if road_id not in legal:
        raise RuntimeError("出口已变化，必须重新规划：" + road_id)
    entered = robot.take_exit(road_id, 40, True)
    if not entered["accepted"]:
        raise RuntimeError("进入道路失败：" + entered["stoppedBy"])

    # 每段最多 4m；前向净空触发时先观察，绝不凭名称或坐标盲闯。
    for _ in range(16):
        scan_camera()
        result = robot.follow_road(400, 40, True)
        scan_camera()
        if result["stoppedBy"] == "max_distance":
            continue
        if result["stoppedBy"] in ("junction", "road_end"):
            visited_roads.add(road_id)
            return "complete"
        if result["stoppedBy"] == "front_clearance":
            blocked_roads.add(road_id)
            print("前方安全停止，标记待绕行道路：", road_id)
            return "blocked"
        raise RuntimeError("道路控制异常停止：" + result["stoppedBy"])
    raise RuntimeError("道路长度超过本示例的巡检上限：" + road_id)

# 一次有限的感知巡检：可安全运行并输出物体候选，便于逐步添加抓放与重规划策略。
for _ in range(len(edges)):
    node = at_node()
    road_id = choose_unseen_exit(node)
    if road_id is None:
        print("当前节点的可达道路已经巡检，等待你的 Dijkstra 重规划策略")
        break
    outcome = inspect_road(road_id)
    print("道路", road_id, "巡检结果：", outcome, "任务进度：", robot.task_state()["completed"], "/", progress["total"])

print("摄像头候选：", seen)
print("已巡检道路：", len(visited_roads), "阻断道路：", sorted(blocked_roads))
print("导航里程：", robot.odometry()["distanceCm"], "cm")`,
  "ai-target-delivery": `# AI 自主任务规划：寻找并投放目标物（实验性示例）
# 本示例只适用于“AI 自主挑战”。物体道路锚点不会下发。
# 决策依据只有：摄像头识别、任务/道路传感、公开道路图与 release_preview。
# 它不是计时路线：每次出口、搜索道路和重规划路径都由当前图状态计算。

mission = robot.mission()
graph = robot.map_graph()
if mission["objects"]:
    raise RuntimeError("请从示例菜单载入本程序，以开启 AI 自主挑战")

edges = {edge["roadId"]: edge for edge in graph["edges"]}
adj = {node["nodeId"]: [] for node in graph["nodes"]}
for edge in graph["edges"]:
    adj[edge["fromNodeId"]].append((edge["toNodeId"], edge["roadId"], edge["lengthCm"]))
    if not edge["oneWay"]:
        adj[edge["toNodeId"]].append((edge["fromNodeId"], edge["roadId"], edge["lengthCm"]))

blocked_roads = set()
searched_roads = set()

def scan_and_grab_target():
    # 三个真实相机朝向；不从任务接口读取目标的位置。
    for turn in (0, 45, -90, 45):
        if turn > 0:
            robot.left_angle(turn)
        elif turn < 0:
            robot.right_angle(-turn)
        observation = robot.observe("目标物", 0.60)
        if observation:
            print("发现目标物：", observation["direction"], observation["distanceCm"], "cm")
            robot.approach("目标物", 95, 60)
            robot.grab()
            if robot.holding() == "目标物":
                print("已抓取目标物")
                return True
    return False

def node_state():
    # follow_road 给出真实道路端/路口；只在边界判定时做一次 2cm 低速前探。
    for _ in range(14):
        state = robot.road_state()
        if state["atNode"]:
            return state
        result = robot.follow_road(500, 40, True)
        if result["stoppedBy"] in ("junction", "road_end"):
            state = robot.road_state()
            if state["atNode"]:
                return state
            robot.forward(2)
            state = robot.road_state()
            if state["atNode"]:
                return state
        elif result["stoppedBy"] == "front_clearance":
            if scan_and_grab_target():
                return None
            raise RuntimeError("道路前方物体未识别为目标物，先停止并更新绕行策略")
        elif result["stoppedBy"] != "max_distance":
            raise RuntimeError("循路被安全停止：" + result["stoppedBy"])
    raise RuntimeError("未能确认当前图节点")

def dijkstra(start_node, goal_node, extra_blocked=None):
    forbidden = set(blocked_roads)
    if extra_blocked:
        forbidden.add(extra_blocked)
    distance = {start_node: 0}
    previous = {}
    closed = set()
    while True:
        current = None
        for node_id, value in distance.items():
            if node_id not in closed and (current is None or value < distance[current]):
                current = node_id
        if current is None or current == goal_node:
            break
        closed.add(current)
        for next_node, road_id, length_cm in adj[current]:
            if road_id in forbidden:
                continue
            candidate = distance[current] + length_cm
            if next_node not in distance or candidate < distance[next_node]:
                distance[next_node] = candidate
                previous[next_node] = (current, road_id)
    if goal_node not in distance:
        return None
    roads = []
    node_id = goal_node
    while node_id != start_node:
        node_id, road_id = previous[node_id]
        roads.append(road_id)
    roads.reverse()
    return roads, distance[goal_node]

def cross_road(road_id, search_target):
    state = node_state()
    if state is None:
        return "target"
    if road_id not in {item["roadId"] for item in state["exits"]}:
        raise RuntimeError("出口不再合法，需要重新规划：" + road_id)
    entered = robot.take_exit(road_id, 40, True)
    if not entered["accepted"]:
        raise RuntimeError("进入道路失败：" + entered["stoppedBy"])
    for _ in range(18):
        if search_target and scan_and_grab_target():
            return "target"
        result = robot.follow_road(400, 40, True)
        if search_target and scan_and_grab_target():
            return "target"
        if result["stoppedBy"] == "max_distance":
            continue
        if result["stoppedBy"] in ("junction", "road_end"):
            return "complete"
        if result["stoppedBy"] == "front_clearance":
            blocked_roads.add(road_id)
            print("道路前方安全停止，加入绕行集合：", road_id)
            return "blocked"
        raise RuntimeError("道路控制异常停止：" + result["stoppedBy"])
    raise RuntimeError("道路过长，超过本示例的控制预算：" + road_id)

def go_to_node(goal_node):
    # 只在当前道路状态、合法出口和 Dijkstra 结果之上行动；遇阻重新计算。
    for _ in range(16):
        state = node_state()
        if state is None:
            return "target"
        if state["nodeId"] == goal_node:
            return "complete"
        plan = dijkstra(state["nodeId"], goal_node)
        if plan is None:
            raise RuntimeError("没有到达节点的公开可行路径：" + goal_node)
        replanning_needed = False
        for road_id in plan[0]:
            outcome = cross_road(road_id, False)
            if outcome == "blocked":
                replanning_needed = True
                break
        if not replanning_needed and node_state()["nodeId"] == goal_node:
            return "complete"
    raise RuntimeError("动态绕行后仍无法到达节点")

def go_to_anchor(anchor):
    # 存放点和途径点是公开任务语义；物体位置不是。
    edge = edges[anchor["roadId"]]
    state = node_state()
    candidates = [edge["fromNodeId"]]
    if not edge["oneWay"]:
        candidates.append(edge["toNodeId"])
    choice = None
    for endpoint in candidates:
        route = dijkstra(state["nodeId"], endpoint, anchor["roadId"])
        if route is None:
            continue
        offset = anchor["progressCm"] if endpoint == edge["fromNodeId"] else edge["lengthCm"] - anchor["progressCm"]
        candidate = (route[1] + offset, endpoint, route[0])
        if choice is None or candidate < choice:
            choice = candidate
    if choice is None:
        raise RuntimeError("没有到达公开任务锚点的路线")
    for road_id in choice[2]:
        if cross_road(road_id, False) != "complete":
            return go_to_anchor(anchor)
    state = node_state()
    entered = robot.take_exit(anchor["roadId"], 40, True)
    if not entered["accepted"]:
        raise RuntimeError("无法进入任务道路：" + entered["stoppedBy"])
    for _ in range(12):
        state = robot.road_state()
        remaining = abs(anchor["progressCm"] - state["roadProgressCm"])
        if remaining <= 12:
            return
        result = robot.follow_road(min(400, max(10, remaining)), 30, True)
        if result["stoppedBy"] in ("junction", "road_end", "front_clearance"):
            break
    raise RuntimeError("未能在道路状态中收敛到任务锚点")

def deliver_target():
    go_to_anchor(mission["storage"])
    # release_preview 是唯一投放真值。有限地沿公开存放道路采样，确认后才释放。
    for _ in range(8):
        preview = robot.release_preview()
        if preview["holding"] == "target" and preview["releaseAccepted"] and preview["wouldCompleteDelivery"]:
            robot.release()
            if robot.task_state()["targetDelivered"]:
                print("目标物已按投放预检送入存放点")
                return
        result = robot.follow_road(35, 20, True)
        if result["stoppedBy"] not in ("max_distance", "junction", "road_end"):
            break
    raise RuntimeError("存放道路附近没有通过投放预检的姿态")

# 先在起点相机中寻找，随后以“最近未搜索道路”为准探索整个公开图。
if not scan_and_grab_target():
    for _ in range(len(edges)):
        state = node_state()
        if state is None:
            break
        candidates = []
        for road_id, edge in edges.items():
            if road_id in searched_roads or road_id in blocked_roads:
                continue
            endpoints = [edge["fromNodeId"]]
            if not edge["oneWay"]:
                endpoints.append(edge["toNodeId"])
            for endpoint in endpoints:
                route = dijkstra(state["nodeId"], endpoint, road_id)
                if route is not None:
                    candidates.append((route[1], road_id, endpoint, route[0]))
        if not candidates:
            break
        _, road_id, endpoint, route = min(candidates)
        for transit_road in route:
            if cross_road(transit_road, True) == "target":
                break
        if robot.holding() == "目标物":
            break
        if node_state()["nodeId"] != endpoint:
            continue
        outcome = cross_road(road_id, True)
        if outcome == "target":
            break
        searched_roads.add(road_id)

if robot.holding() != "目标物":
    raise RuntimeError("本轮感知巡检没有找到目标物；请查看摄像头日志并改进搜索策略")

deliver_target()
print("目标物任务状态：", robot.task_state())
print("已搜索道路：", len(searched_roads), "阻断道路：", sorted(blocked_roads))
print("导航里程：", robot.odometry()["distanceCm"], "cm")`,
  "topology-plan": `# 广阳岛：真实道路拓扑规划模板（前往当前下一途径点）
# 只使用 mission / task_state / release_preview / map_graph / road_state / follow_road / take_exit。
# 它不是完整任务答案：物体搜索、抓放与绕障仍应由你继续补充。
mission = robot.mission()
progress = robot.task_state()
graph = robot.map_graph()

edges = {edge["roadId"]: edge for edge in graph["edges"]}
adj = {node["nodeId"]: [] for node in graph["nodes"]}
for edge in graph["edges"]:
    adj[edge["fromNodeId"]].append((edge["toNodeId"], edge["roadId"], edge["lengthCm"]))
    if not edge["oneWay"]:
        adj[edge["toNodeId"]].append((edge["fromNodeId"], edge["roadId"], edge["lengthCm"]))

def shortest_roads(start_node, goal_node, blocked_road):
    # Dijkstra：路线由学生代码计算，系统不提供推荐出口或自动寻路。
    distance = {start_node: 0}
    previous = {}
    visited = set()
    while True:
        current = None
        for node_id, value in distance.items():
            if node_id not in visited and (current is None or value < distance[current]):
                current = node_id
        if current is None or current == goal_node:
            break
        visited.add(current)
        for next_node, road_id, length_cm in adj[current]:
            if road_id == blocked_road:
                continue
            candidate = distance[current] + length_cm
            if next_node not in distance or candidate < distance[next_node]:
                distance[next_node] = candidate
                previous[next_node] = (current, road_id)
    if goal_node not in distance:
        return None
    roads = []
    node_id = goal_node
    while node_id != start_node:
        node_id, road_id = previous[node_id]
        roads.append(road_id)
    roads.reverse()
    return roads, distance[goal_node]

def arrive_at_node():
    # 先用受限道路控制抵达一个图节点；不使用时间/坐标猜测节点。
    for _ in range(12):
        state = robot.road_state()
        if state["atNode"]:
            return state["nodeId"]
        result = robot.follow_road(500, 30)
        if result["stoppedBy"] not in ("max_distance", "junction", "road_end"):
            raise RuntimeError("循路被安全停止：" + result["stoppedBy"])
    raise RuntimeError("没有在道路控制预算内抵达节点")

def cross_selected_road(road_id):
    state = robot.road_state()
    if not state["atNode"]:
        raise RuntimeError("选择出口前必须先到道路节点")
    if road_id not in [item["roadId"] for item in state["exits"]]:
        raise RuntimeError("规划出口已不再合法，需重新读取 road_state 并重规划")
    entered = robot.take_exit(road_id)
    if not entered["accepted"]:
        raise RuntimeError("进入道路失败：" + entered["stoppedBy"])
    for _ in range(20):
        result = robot.follow_road(500, 30)
        if result["stoppedBy"] in ("junction", "road_end"):
            return robot.road_state()["nodeId"]
        if result["stoppedBy"] != "max_distance":
            raise RuntimeError("道路被安全停止：" + result["stoppedBy"])
    raise RuntimeError("道路长度超出本示例的单段上限")

next_id = progress["nextCheckpointId"]
anchors = {item["id"]: item for item in mission["checkpoints"]}
anchor = anchors.get(next_id, mission["return"])
target_edge = edges[anchor["roadId"]]
current_node = arrive_at_node()

# 先到目标道路较近、且符合单行方向的一个端点。
endpoints = [target_edge["fromNodeId"]]
if not target_edge["oneWay"]:
    endpoints.append(target_edge["toNodeId"])
choice = None
for endpoint in endpoints:
    route = shortest_roads(current_node, endpoint, anchor["roadId"])
    if route is not None and (choice is None or route[1] < choice[2]):
        choice = (endpoint, route[0], route[1])
if choice is None:
    raise RuntimeError("没有到达下一任务道路的公开可行路线")

for road_id in choice[1]:
    current_node = cross_selected_road(road_id)

# 从选定端点驶入目标道路，并按公开 progressCm 靠近任务锚点。
entered = robot.take_exit(anchor["roadId"])
if not entered["accepted"]:
    raise RuntimeError("无法驶入任务道路：" + entered["stoppedBy"])
# take_exit 的 distanceCm 是本次动作里程，并不是道路上的绝对位置。
# 进入道路后重新读取 canonical roadProgressCm，两个进入方向都不会算错。
state = robot.road_state()
if state["roadId"] != anchor["roadId"] or state["roadProgressCm"] is None:
    raise RuntimeError("进入任务道路后无法读取道路进度")
remaining_cm = abs(anchor["progressCm"] - state["roadProgressCm"])
while remaining_cm >= 10:
    result = robot.follow_road(min(500, remaining_cm), 30)
    state = robot.road_state()
    if state["roadId"] != anchor["roadId"] or state["roadProgressCm"] is None:
        break
    remaining_cm = abs(anchor["progressCm"] - state["roadProgressCm"])
    if result["stoppedBy"] != "max_distance":
        break

print("已按公开道路锚点规划至：", anchor["id"])
print("导航里程：", robot.odometry()["distanceCm"], "cm")
print("真实任务进度：", robot.task_state())

# 找到混淆物并抓取后，先用道路控制把车停在你选择的投放姿态。
# release_preview 不给坐标，只确认此刻立即释放是否会真正完成该项任务。
preview = robot.release_preview()
if preview["holding"] == "distractor" and preview["releaseAccepted"] and preview["wouldCompleteDelivery"]:
    robot.release()
    print("混淆物已按安全预览释放：", robot.task_state())`,
  avoid: `# 3D 模拟器：前方有障碍物就转弯
for _ in range(12):
    if robot.observe("障碍物"):
        robot.left_angle(45)
    else:
        robot.forward(6.3)`,
  "find-ball": `# 3D 模拟器：每次转 45°，最多搜索一整圈
found = False
for _ in range(8):
    if robot.observe("目标物"):
        found = True
        break
    robot.right_angle(45)

if found and robot.approach("目标物", 100):
    robot.grab()
    print("夹到目标物")
else:
    print("没有稳定识别并安全靠近目标物")`,
  detect: `# 3D 模拟器：查看虚拟车载摄像头的识别结果
print(robot.observe())`,
  align: `# 3D 模拟器：根据虚拟摄像头画面与目标物对正
objects = robot.observe("目标物")
direction = objects[0]["direction"] if objects else "未找到"
print("目标物在", direction)

if direction == "左":
    robot.left_angle(8)
elif direction == "右":
    robot.right_angle(8)
elif direction == "中间":
    print("已经对正")`,
  approach: `# 3D 模拟器：自动靠近目标物，并确保前方安全
if robot.approach("目标物", 100):
    robot.grab()
    print("夹取完成")
else:
    print("没有安全靠近目标")`,
  "training-target": `# 广阳岛同图训练：观察并夹取目标物
# 视觉 API 只返回类别、方向、距离和置信度，不返回地图坐标或对象编号。
objects = robot.observe("目标物")
print("目标物观察：", objects)
if objects and robot.approach("目标物", 100, 80):
    robot.grab()
    print("夹爪当前持有：", robot.holding())
    print("下一步：自行搜索存放点并规划道路路线")
else:
    print("没有稳定观察到目标物，请调整朝向后再试")`,
  "training-obstacle": `# 广阳岛同图训练：读取障碍物方位和距离
obstacles = robot.observe("障碍物")
if obstacles:
    obstacle = obstacles[0]
    print("障碍物：", obstacle["direction"], obstacle["distanceCm"], "cm")
    print("请规划其他道路绕开；不要直接向障碍物前进")
else:
    print("摄像头没有稳定观察到障碍物，请小角度转动后再试")`,
  "training-distractor": `# 广阳岛同图训练：识别并夹取混淆物
# 混淆物不是目标物，最终要放到道路边界外。
objects = robot.observe("混淆物")
print("混淆物观察：", objects)
if objects and robot.approach("混淆物", 100, 80):
    robot.grab()
    print("夹爪当前持有：", robot.holding())
    road = robot.road_state()
    print("道路左右余量：", road["leftClearanceCm"], road["rightClearanceCm"], "cm")
    print("下一步：自行选择道路边界，保持小车在路内并把混淆物完整释放到边界外")
else:
    print("没有稳定观察到混淆物，请调整朝向后再试")`
};

function initVirtualCamera() {
  disposeVirtualCamera();
  if (!renderer || !robotGroup) return;
  virtualCamera = new THREE.PerspectiveCamera(
    VIRTUAL_CAMERA_FOV,
    VIRTUAL_CAMERA_WIDTH / VIRTUAL_CAMERA_HEIGHT,
    0.04,
    30
  );
  virtualCamera.position.set(0, 0.54, -0.43);
  virtualCamera.rotation.x = THREE.MathUtils.degToRad(-8);
  virtualCamera.name = "robot-virtual-camera";
  robotGroup.add(virtualCamera);
  virtualCameraTarget = new THREE.WebGLRenderTarget(
    VIRTUAL_CAMERA_WIDTH,
    VIRTUAL_CAMERA_HEIGHT,
    {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false
    }
  );
  virtualCameraTarget.texture.colorSpace = THREE.SRGBColorSpace;
  virtualCameraTarget.texture.generateMipmaps = false;
  virtualCameraCanvas = document.createElement("canvas");
  virtualCameraCanvas.width = VIRTUAL_CAMERA_WIDTH;
  virtualCameraCanvas.height = VIRTUAL_CAMERA_HEIGHT;
  virtualCameraContext = virtualCameraCanvas.getContext("2d", { willReadFrequently: true });
  virtualCameraPixels = new Uint8Array(VIRTUAL_CAMERA_WIDTH * VIRTUAL_CAMERA_HEIGHT * 4);
  virtualCameraImageData = virtualCameraContext?.createImageData(VIRTUAL_CAMERA_WIDTH, VIRTUAL_CAMERA_HEIGHT) || null;
  latestVirtualCameraFrameId = null;
}

function updateVirtualCameraPose() {
  if (!virtualCamera || !robotGroup) return;
  robotGroup.updateMatrixWorld(true);
  virtualCamera.updateMatrixWorld(true);
}

function addCompetitionVisionEvidence(canvas, frameId, captureContext = null) {
  if (!canvas || !competitionSession || competitionSession.status !== "running"
    || typeof competitionSession.addVisionEvidence !== "function") return null;
  const payloadBase64 = canvas.toDataURL("image/png");
  return competitionSession.addVisionEvidence({
    frameId,
    ...(captureContext ? { tick: captureContext.tick, stateRevision: captureContext.stateRevision } : {}),
    width: canvas.width,
    height: canvas.height,
    payloadBase64,
    cameraDefinitionHash: globalThis.CompetitionCore?.CAMERA_DEFINITION_HASH,
    detectorDefinitionHash: globalThis.CompetitionCore?.DETECTOR_DEFINITION_HASH
  });
}

function addCompetitionVisionQuery(method, args, result, frameId) {
  if (!competitionSession || competitionSession.status !== "running"
    || typeof competitionSession.addVisionQuery !== "function") return null;
  return competitionSession.addVisionQuery(method, args, result, frameId);
}

async function captureVirtualCameraFrame() {
  if (!renderer || !scene || !virtualCamera || !virtualCameraTarget || !virtualCameraContext || !virtualCameraImageData) {
    throw new Error("虚拟车载摄像头尚未初始化。");
  }
  const captureGeneration = virtualCameraGeneration;
  await ensureSimulationSceneReady();
  if (captureGeneration !== virtualCameraGeneration) return null;
  if (navigationVisualPlayback) throw new Error("Cannot observe during navigation visual playback");
  const captureContext = simulationVisionRunActive ? simulationVisionContext() : null;
  const previousRenderTarget = renderer.getRenderTarget();
  const reliefWasVisible = guangyangReliefRoot?.visible;
  const flatMapWasVisible = guangyangFlatMapPlane?.visible;
  const hiddenRobotParts = [];
  const hiddenHelpers = [];
  const hiddenCameraOverlays = [];
  scene.traverse(object => {
    if (object?.visible && object.userData?.hideFromVirtualCamera === true) {
      hiddenCameraOverlays.push(object);
      object.visible = false;
    }
  });
  robotGroup.children.forEach(child => {
    if (child !== virtualCamera && child.visible) {
      hiddenRobotParts.push(child);
      child.visible = false;
    }
  });
  [trajectoryLine, trajectoryHead].forEach(object => {
    if (object?.visible) {
      hiddenHelpers.push(object);
      object.visible = false;
    }
  });
  try {
    if (guangyangReliefRoot) guangyangReliefRoot.visible = true;
    if (guangyangFlatMapPlane && guangyangTerrainMesh) guangyangFlatMapPlane.visible = false;
    const elapsedMs = captureContext ? captureContext.tick * captureContext.stepMs : simulationSceneElapsedMs();
    if (elapsedMs !== null) animateSceneEffects(elapsedMs / 1000, elapsedMs);
    scene.updateMatrixWorld(true);
    updateVirtualCameraPose();
    // setRenderTarget applies the target's own pixel-exact viewport/scissor.
    // Calling renderer.setViewport(640, 480) here would multiply those values
    // by the screen DPR and crop the camera on high-density displays.
    renderer.setRenderTarget(virtualCameraTarget);
    // Capture must not reuse a shadow rendered at an arbitrary earlier rAF.
    renderer.shadowMap.needsUpdate = true;
    renderer.clear(true, true, true);
    renderer.render(scene, virtualCamera);
    renderer.readRenderTargetPixels(
      virtualCameraTarget,
      0,
      0,
      VIRTUAL_CAMERA_WIDTH,
      VIRTUAL_CAMERA_HEIGHT,
      virtualCameraPixels
    );
    const rowBytes = VIRTUAL_CAMERA_WIDTH * 4;
    for (let y = 0; y < VIRTUAL_CAMERA_HEIGHT; y += 1) {
      const sourceStart = (VIRTUAL_CAMERA_HEIGHT - 1 - y) * rowBytes;
      virtualCameraImageData.data.set(
        virtualCameraPixels.subarray(sourceStart, sourceStart + rowBytes),
        y * rowBytes
      );
    }
    virtualCameraContext.putImageData(virtualCameraImageData, 0, 0);
  } finally {
    hiddenRobotParts.forEach(object => { object.visible = true; });
    hiddenHelpers.forEach(object => { object.visible = true; });
    hiddenCameraOverlays.forEach(object => { object.visible = true; });
    if (guangyangReliefRoot && reliefWasVisible !== undefined) guangyangReliefRoot.visible = reliefWasVisible;
    if (guangyangFlatMapPlane && flatMapWasVisible !== undefined) guangyangFlatMapPlane.visible = flatMapWasVisible;
    // Restoring the previous target also restores its associated viewport,
    // scissor and scissor-test state without applying the screen DPR twice.
    renderer.setRenderTarget(previousRenderTarget);
    sceneShadowDirty = true;
  }
  const vision = await window.CarVision?.analyzeFrame?.(virtualCameraCanvas, {
    source: "virtual",
    fovDegrees: VIRTUAL_CAMERA_FOV,
    cameraForwardOffset: 0.43,
    virtualPixelClasses: [...VIRTUAL_PIXEL_CLASSES]
  });
  if (captureGeneration !== virtualCameraGeneration) return null;
  latestVirtualCameraFrameId = vision?.frameId ?? window.CarVision?.getStatus?.().frameId ?? null;
  if (captureContext) {
    const current = simulationVisionContext();
    if (Object.keys(captureContext).some(key => captureContext[key] !== current[key])) {
      throw new Error("Simulation changed during virtual camera capture");
    }
  }
  addCompetitionVisionEvidence(virtualCameraCanvas, latestVirtualCameraFrameId, captureContext);
  try {
    renderTrainingVisionWorkbenchFrame(
      virtualCameraCanvas,
      window.CarVision?.getDetections?.() || [],
      latestVirtualCameraFrameId
    );
  } catch (_error) {
    clearTrainingVisionWorkbench("摄像头识别结果暂时无法显示", "error");
  }
  return { canvas: virtualCameraCanvas, frameId: latestVirtualCameraFrameId };
}

function startVirtualCameraVision() {
  if (virtualCameraCapturePromise) return virtualCameraCapturePromise;
  const pendingCapture = captureVirtualCameraFrame();
  virtualCameraCapturePromise = pendingCapture;
  pendingCapture.then(
    () => {
      if (virtualCameraCapturePromise === pendingCapture) virtualCameraCapturePromise = null;
    },
    () => {
      if (virtualCameraCapturePromise === pendingCapture) virtualCameraCapturePromise = null;
    }
  );
  return pendingCapture;
}

function invalidateVirtualCameraFrame() {
  virtualCameraGeneration += 1;
  latestVirtualCameraFrameId = null;
  virtualCameraCapturePromise = null;
  clearTrainingVisionWorkbench("等待当前练习场景的新画面");
  // Scene-specific detections must never survive a mission rebuild. The next
  // analyzeFrame() call re-enables the manual virtual source automatically.
  window.CarVision?.stop?.();
}

function disposeVirtualCamera() {
  invalidateVirtualCameraFrame();
  virtualCameraTarget?.dispose();
  virtualCamera?.removeFromParent();
  virtualCameraTarget = null;
  virtualCamera = null;
  virtualCameraCanvas = null;
  virtualCameraContext = null;
  virtualCameraPixels = null;
  virtualCameraImageData = null;
  virtualCameraCapturePromise = null;
  latestVirtualCameraFrameId = null;
}

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color("#091321");
  scene.fog = new THREE.Fog("#091321", 15, 34);
  camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
  camera.position.set(7.1, 8.6, 8.6);
  camera.lookAt(0, 0, 0);

  const simulationCanvas = document.querySelector("#simCanvas");
  try {
    renderer = new THREE.WebGLRenderer({ canvas: simulationCanvas, antialias: true });
  } catch (error) {
    showSimulationStartupError(error?.message || "浏览器无法创建 WebGL 渲染器");
    throw error;
  }
  simulationCanvas.addEventListener("webglcontextlost", event => {
    event.preventDefault();
    if (runButton) runButton.disabled = true;
    setStatus("3D 渲染环境已中断，请等待恢复或刷新页面");
    showPythonFeedback("3D 渲染环境已中断", "浏览器的 WebGL 上下文已丢失。若页面没有自动恢复，请刷新后重试。");
  });
  simulationCanvas.addEventListener("webglcontextrestored", () => {
    window.location.reload();
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
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
  sunLight = sun;
  const rim = new THREE.DirectionalLight(0x38bdf8, 0.54);
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

  const floorGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_SIZE + 1.6, MAP_SIZE + 1.6),
    new THREE.MeshBasicMaterial({
      color: "#38bdf8",
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    })
  );
  floorGlow.rotation.x = -Math.PI / 2;
  floorGlow.position.y = -0.012;
  floorGlow.renderOrder = 0;
  floorGlow.visible = false;
  scene.add(floorGlow);
  floorGlowMesh = floorGlow;

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
  initVirtualCamera();
  initTrajectoryLine();

  raycaster = new THREE.Raycaster();
  simulator.addEventListener("click", placeObjectFromClick);
  simulator.addEventListener("pointerdown", startOrbitDrag);
  simulator.addEventListener("pointermove", orbitDrag);
  simulator.addEventListener("pointerup", endOrbitDrag);
  simulator.addEventListener("pointercancel", endOrbitDrag);
  simulator.addEventListener("lostpointercapture", endOrbitDrag);
  simulator.addEventListener("wheel", zoomCamera, { passive: false });
  window.addEventListener("resize", () => {
    const current = Number.parseFloat(getComputedStyle(workspaceGrid).getPropertyValue("--right-panel-width")) || defaultRightPanelWidth();
    setRightPanelWidth(current, false);
    const stateHeight = Number.parseFloat(getComputedStyle(sidePanel).getPropertyValue("--state-panel-height")) || 148;
    setStatePanelHeight(stateHeight, false);
  });
  window.addEventListener("orientationchange", resizeRenderer);
  window.visualViewport?.addEventListener("resize", resizeRenderer);
  if ("ResizeObserver" in window) {
    simulatorResizeObserver = new ResizeObserver(resizeRenderer);
    simulatorResizeObserver.observe(simulator);
  }
  resizeRenderer();
  setCameraMode("iso");
  loadMission("guangyang");
  animate();
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
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(12, 18, 232, 60, 14);
  } else {
    ctx.moveTo(26, 18);
    ctx.lineTo(230, 18);
    ctx.quadraticCurveTo(244, 18, 244, 32);
    ctx.lineTo(244, 64);
    ctx.quadraticCurveTo(244, 78, 230, 78);
    ctx.lineTo(26, 78);
    ctx.quadraticCurveTo(12, 78, 12, 64);
    ctx.lineTo(12, 32);
    ctx.quadraticCurveTo(12, 18, 26, 18);
    ctx.closePath();
  }
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
  label.userData.kind = "scene-label";
  label.userData.hideFromVirtualCamera = true;
  scene.add(label);
  return label;
}

function attachObjectNameLabel(object, text, height = 0.76) {
  if (!object || !text) return null;
  const label = createTextLabel(String(text), 0, 0, height);
  label.removeFromParent();
  label.position.set(0, height, 0);
  // Competition object labels need to remain readable in the wide Guangyang view.
  label.scale.set(1.45, 0.55, 1);
  label.userData.objectNameLabel = true;
  object.add(label);
  return label;
}

function getMissionVisualPalette() {
  const palettes = {
    delivery: { background: "#091522", floor: "#46576a", base: "#1b2b3d", accent: "#38bdf8", obstacle: "#53657a" },
    vision: { background: "#0d1728", floor: "#46576a", base: "#1b2b3d", accent: "#38bdf8", obstacle: "#53657a" },
    objectTraining: { background: "#071826", floor: "#344b5d", base: "#10293c", accent: "#67e8f9", obstacle: "#111827" },
    campus: { background: "#0a1b22", floor: "#48605e", base: "#183331", accent: "#34d399", obstacle: "#596f69" },
    warehouse: { background: "#0c1420", floor: "#3f4b5a", base: "#182331", accent: "#f59e0b", obstacle: "#4b607a" },
    training: { background: "#131522", floor: "#4c5262", base: "#202637", accent: "#fb923c", obstacle: "#c45b2d" },
    harbor: { background: "#061823", floor: "#344e5b", base: "#102b36", accent: "#22d3ee", obstacle: "#35698a" },
    guangyang: { background: "#0b2944", floor: "#2f75a9", base: "#153852", accent: "#facc15", obstacle: "#d97706" },
    city: { background: "#071827", floor: "#3b5264", base: "#14293a", accent: "#22d3ee", obstacle: "#334b63" },
    canyon: { background: "#21140e", floor: "#685342", base: "#2d2119", accent: "#fb923c", obstacle: "#78553d" },
    sandbox: { background: "#0b1727", floor: "#48586a", base: "#1a2b3e", accent: "#a78bfa", obstacle: "#5d6b80" },
    maze: { background: "#080b12", floor: "#263445", base: "#111923", accent: "#f59e0b", obstacle: "#b9814e" }
  };
  return palettes[activeMission?.environment] || palettes.delivery;
}

function updateSceneAtmosphere(competition) {
  const palette = getMissionVisualPalette();
  const background = competition ? "#091522" : palette.background;
  scene.background.set(background);
  if (!scene.fog) scene.fog = new THREE.Fog(background, 15, 34);
  scene.fog.color.set(background);
  scene.fog.near = isLargeMap() ? Math.max(31, currentMapSize() * 0.58) : 15;
  scene.fog.far = isLargeMap() ? Math.max(70, currentMapSize() * 2.2) : 32;
  camera.far = Math.max(100, currentMapSize() * 3);
  camera.updateProjectionMatrix();
}

function setMapStyle(style, refreshObjects = true) {
  if (refreshObjects && running) {
    if (mapStyleSelect) mapStyleSelect.value = currentMapStyle;
    setStatus("请先停止程序再切换地图外观");
    return;
  }
  simulator?.classList.toggle("is-maze-map", activeMission.theme === "maze");
  simulator?.classList.toggle("is-competition-map", isCompetitionMission());
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
  const mapWidthScale = currentMapWidth() / MAP_SIZE;
  const mapDepthScale = currentMapDepth() / MAP_SIZE;
  floorMesh.scale.set(mapWidthScale, mapDepthScale, 1);
  if (floorBaseMesh) floorBaseMesh.scale.set(mapWidthScale, 1, mapDepthScale);
  if (floorGlowMesh) {
    floorGlowMesh.scale.set(
      (currentMapWidth() + 1.6) / (MAP_SIZE + 1.6),
      (currentMapDepth() + 1.6) / (MAP_SIZE + 1.6),
      1
    );
    floorGlowMesh.visible = activeMission?.environment === "guangyang";
  }
  const palette = getMissionVisualPalette();
  floorMesh.material.color.set(competition ? "#536273" : palette.floor);
  if (floorBaseMesh) {
    const guangyang = activeMission?.environment === "guangyang";
    floorBaseMesh.material.color.set(guangyang ? "#102f49" : competition ? "#1b2c3b" : palette.base);
    floorBaseMesh.material.emissive?.set(guangyang ? "#071b2d" : "#000000");
    floorBaseMesh.material.emissiveIntensity = guangyang ? 0.38 : 0;
  }
  updateSceneAtmosphere(competition);
  if (sunLight?.shadow?.camera) {
    const shadowExtent = Math.max(currentMapWidth(), currentMapDepth()) * 0.72;
    sunLight.shadow.camera.left = -shadowExtent;
    sunLight.shadow.camera.right = shadowExtent;
    sunLight.shadow.camera.top = shadowExtent;
    sunLight.shadow.camera.bottom = -shadowExtent;
    sunLight.shadow.camera.far = Math.max(42, currentMapSize() * 2.4);
    sunLight.shadow.camera.updateProjectionMatrix();
  }
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
      ? `已切换到 ${currentMapWidth()}×${currentMapDepth()} 大型主题地图。`
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
  const bounds = currentPlayableBounds(radius);
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
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
  const bounds = currentPlayableBounds(1);
  for (let x = bounds.minX; x <= bounds.maxX; x += step) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += step) {
      if (!pointAvailableForRobot(x, z)) continue;
      const distance = Math.hypot(x - pos.x, z - pos.z);
      if (!best || distance < best.distance) best = { x, z, distance };
    }
  }
  return best;
}

function ensureRobotOnFreeCell() {
  if (!robotGroup) return;
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
  const bounds = currentPlayableBounds(1);
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
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

function loadMission(key, options = {}) {
  if (!missions[key]) return;
  if (running && realtimeRun?.target === "real") {
    setStatus("请先停止真实小车再切换场景");
    addLog("为防止实车失控，运行期间不能载入场景。请先点击“停止”。", true);
    return;
  }
  if ((managedFiveRunIsOpen() || rankedEvaluationLocksWorkspace()) && !options.batchInternal) {
    setStatus(rankedEvaluationLocksWorkspace()
      ? "筛选五局进行中，不能切换场景"
      : "练习五局进行中（不入榜），不能切换场景");
    const sceneSelect = document.querySelector("#sceneSelect");
    if (sceneSelect) sceneSelect.value = "guangyang";
    return;
  }
  clearTrainingVisionWorkbench("正在切换训练场景（识别练习）…");
  stopCompetitionReplay();
  competitionSessionAbortController?.abort();
  if (competitionSession?.status === "running") finishCompetitionRun("mission_changed");
  if (running) {
    runToken++;
    stopRequested = true;
    pauseRequested = false;
    running = false;
    if (competitionTeamIdInput) competitionTeamIdInput.disabled = managedFiveRunIsOpen();
    cancelPythonCollection();
  }
  missionAttempt = null;
  const selectedGuangyangConfig = isGuangyangMissionKey(key)
    ? guangyangConfigForTaskId(Object.entries(GUANGYANG_MISSION_KEY_BY_TASK_ID)
      .find(([, missionKey]) => missionKey === key)?.[0])
    : null;
  activeMission = key === "guangyang" && options.trainingMode
    ? buildGuangyangTrainingMission(options.trainingMode)
    : selectedGuangyangConfig && !options.batchInternal
      && publishedGuangyangMissions.get(selectedGuangyangConfig.taskId)
      ? structuredClone(publishedGuangyangMissions.get(selectedGuangyangConfig.taskId))
      : structuredClone(missions[key]);
  if (key === "guangyang" && !options.trainingMode && !options.batchInternal && guangyangAiAutonomyMode) {
    activeMission.aiAutonomyMode = true;
    applyGuangyangAiAutonomyPresentation(activeMission);
  }
  activeMission.packages = normalizePackageRecords(activeMission);
  renderMissionInfo();
  captureMissionBaseline();
  const missionMapStyle = activeMission.mapStyle || "basic";
  if (mapStyleSelect) mapStyleSelect.value = missionMapStyle;
  setMapStyle(missionMapStyle, false);
  setCompetitionHudVisibility();
  if (isCompetitionMission()) setMissionCardCollapsed(true, { persist: false });
  else if (isObjectTrainingMission()) setMissionCardCollapsed(false, { persist: false });
  resetRobot();
  rebuildSceneObjects();
  setCameraMode(activeMission.environment === "guangyang"
    ? isGuangyangAiAutonomyMission() ? "follow" : "iso"
    : isCompetitionMission() ? "top" : cameraMode === "free" ? "iso" : cameraMode);
  clearActionLog();
  addLog("已载入场景，小车在起点等待。");
  initializeMissionAttempt();
  if (!missionAttempt?.completed) setStatus("等待编程");
}

function enterGuangyangTrainingMode(mode = "target") {
  const normalizedMode = Object.hasOwn(GUANGYANG_TRAINING_PROFILES, mode) ? mode : "target";
  const sceneSelect = document.querySelector("#sceneSelect");
  if (sceneSelect) sceneSelect.value = "guangyang";
  loadMission("guangyang", { trainingMode: normalizedMode });
  setStatus("已进入广阳岛摄像头识别练习（不会训练模型）");
}

function exitGuangyangTrainingMode() {
  const sceneSelect = document.querySelector("#sceneSelect");
  if (sceneSelect) sceneSelect.value = "guangyang";
  loadMission("guangyang");
  setStatus("已返回广阳岛正式比赛");
}

function disposeSceneObject(object, resources = null) {
  if (!object) return;
  const disposed = resources || { geometries: new Set(), materials: new Set(), textures: new Set() };
  if (object.parent) object.parent.remove(object);
  if (object.userData?.kind === "package") {
    object.traverse(node => {
      if (!node.userData?.objectNameLabel) return;
      node.material?.map?.dispose?.();
      node.material?.dispose?.();
    });
    return;
  }
  object.traverse(node => {
    if (node.isInstancedMesh) node.dispose();
    if (node.geometry?.dispose && !disposed.geometries.has(node.geometry)) {
      disposed.geometries.add(node.geometry);
      node.geometry.dispose();
    }
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    materials.forEach(material => {
      if (disposed.materials.has(material)) return;
      disposed.materials.add(material);
      Object.values(material).forEach(value => {
        if (value?.isTexture && value.dispose && !disposed.textures.has(value)) {
          disposed.textures.add(value);
          value.dispose();
        }
      });
      material.dispose?.();
    });
  });
}

function rebuildSceneObjects() {
  invalidateVirtualCameraFrame();
  invalidateDeterministicSimulator();
  missionBuildGeneration += 1;
  simulationSceneReadyPromise = Promise.resolve();
  ensureMissionPackages();
  sanitizeMissionForCurrentMapStyle();
  const staleObjects = new Set([...obstacleMeshes, ...markerMeshes, ...missionWallMeshes, ...missionDecorationMeshes]);
  const disposedResources = { geometries: new Set(), materials: new Set(), textures: new Set() };
  staleObjects.forEach(object => disposeSceneObject(object, disposedResources));
  obstacleMeshes = [];
  markerMeshes = [];
  missionWallMeshes = [];
  missionWallColliders = [];
  missionDecorationMeshes = [];
  guangyangReliefRoot = null;
  guangyangFlatMapPlane = null;
  guangyangTerrainMesh = null;
  missionCheckpointPositions = [];
  goalPulseEffects = [];
  mazeSignalEffects = [];
  competitionTrafficLightVisuals = [];
  packageMeshes = [];
  heldPackageId = null;
  heldPackageMesh = null;
  if (robotClaw) robotClaw.scale.x = 1;

  if (activeMission.theme === "maze") {
    buildMazeMission();
  } else {
    if (isLargeMap() && activeMission.environment !== "guangyang") buildLargeMissionBase();
    buildStandardMissionWalls();
  }
  buildMissionEnvironment();

  activeMission.obstacles.forEach(([x, z], index) => {
    const block = createObstacleModel(x, z, index);
    scene.add(block);
    obstacleMeshes.push(block);
  });
  (activeMission.objectObstacles || []).forEach((record, index) => {
    const block = createObstacleModel(
      Number(record.x ?? record.position?.[0]),
      Number(record.z ?? record.position?.[1]),
      activeMission.obstacles.length + index,
      record
    );
    scene.add(block);
    obstacleMeshes.push(block);
  });

  activeMission.packages.forEach((record, index) => {
    addPackageMarker(record, packageStackLevelForIndex(activeMission.packages, index), index);
  });
  (activeMission.objectZones || []).forEach(addObjectTaskZoneMarker);
  if (activeMission.goal && !activeMission.trainingOnGuangyang) {
    addMarker(activeMission.goal, "goal", activeMission.goalColor || "#22c55e");
  }
  rebuildRobotCollisionShapes();
  ensureRobotOnFreeCell();
  updateDistance();
  updateRobotState();
  renderer?.renderLists?.dispose();
  markSceneShadowDirty();
}

function createObstacleModel(x, z, index = 0, definition = null) {
  const palette = getMissionVisualPalette();
  const group = new THREE.Group();
  const roleObstacle = definition?.role === "obstacle";
  const stoneObstacle = activeMission.environment === "guangyang"
    && (activeMission.objectTraining?.type === "obstacle-avoidance" || roleObstacle);
  const bodyColor = stoneObstacle ? "#64748b" : palette.obstacle;
  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    metalness: stoneObstacle ? 0 : 0.12,
    roughness: stoneObstacle ? 0.96 : 0.58,
    flatShading: stoneObstacle
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: "#1e293b", metalness: 0.3, roughness: 0.42 });
  // The warning stripe is the obstacle's camera-readable signature. Keep its
  // colour independent from scene lighting so the frozen pixel detector sees
  // the same yellow in training and competition views.
  const warningMat = new THREE.MeshBasicMaterial({ color: "#facc15", toneMapped: false });

  if (stoneObstacle) {
    // 广阳岛的正式障碍物是天然石块；黄色反光带保留为车载摄像头稳定、
    // 可复算的障碍物识别特征，而不是把石头伪装成纸箱或路障。
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.55, 0.09, 10), darkMat);
    base.position.y = 0.055;
    group.add(base);
    const body = new THREE.Mesh(new THREE.DodecahedronGeometry(0.46, 1), bodyMat);
    body.position.y = 0.43;
    body.scale.set(1.05, 0.88, 0.96);
    body.rotation.set(0.18, index * 0.73, -0.12);
    group.add(body);
    const accentMat = new THREE.MeshStandardMaterial({ color: "#94a3b8", roughness: 1, flatShading: true });
    const accent = new THREE.Mesh(new THREE.DodecahedronGeometry(0.19, 0), accentMat);
    accent.position.set(-0.24, 0.25, 0.18);
    accent.rotation.set(0.3, -0.5, 0.18);
    group.add(accent);
    [-1, 1].forEach(side => {
      const frontBand = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.11, 0.024), warningMat);
      frontBand.position.set(0, 0.42, side * 0.37);
      group.add(frontBand);
      const sideBand = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.11, 0.44), warningMat);
      sideBand.position.set(side * 0.37, 0.42, 0);
      group.add(sideBand);
    });
  } else {
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
  }
  group.position.set(x, activeMission.environment === "guangyang" ? 0.105 : 0, z);
  group.rotation.y = index % 2 ? Math.PI / 2 : 0;
  group.userData.kind = "block";
  group.userData.objectCategory = "障碍物";
  group.userData.objectRole = roleObstacle ? "obstacle" : null;
  group.userData.interactionObjectId = definition?.id ? String(definition.id) : null;
  group.userData.collisionRadius = Number(definition?.radius) > 0 ? Number(definition.radius) : BLOCK_RADIUS;
  if (activeMission.environment === "guangyang" && roleObstacle && !isGuangyangAiAutonomyMission()) {
    attachObjectNameLabel(group, "障碍物", 1.02);
  }
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
  const zoneDecal = addFloorDecal(pos[0], pos[1], 1.3, 0.95, color, 0.2);
  // This category-coloured floor hint is useful in the main scene but is not
  // part of the physical camera target. Hiding it from evidence prevents the
  // decal from joining the upright sign into a wide, distance-skewing blob.
  if (zoneDecal) zoneDecal.userData.hideFromVirtualCamera = true;
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
  const borderMaterial = new THREE.MeshStandardMaterial({ color: palette.base, metalness: 0.18, roughness: 0.58 });
  const border = currentMapHalf() - 0.2;
  const length = size - 0.3;
  [
    [0, -border, length, 0.12], [0, border, length, 0.12],
    [-border, 0, 0.12, length], [border, 0, 0.12, length]
  ].forEach(([x, z, w, h]) => addMazeWall(x, z, w, h, 0.58, borderMaterial));
}

function addStartMarker() {
  if (activeMission.environment === "guangyang") return;
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
  group.position.set(x, activeMission.environment === "guangyang" ? 0.09 : 0, z);
  group.rotation.y = heading;
  if (activeMission.theme === "maze") group.scale.setScalar(1.22);
  addMissionDecoration(group);
  const label = createTextLabel("起点", x, z + 0.72, 0.1);
  label.scale.set(activeMission.theme === "maze" ? 1.08 : 0.92, activeMission.theme === "maze" ? 0.4 : 0.34, 1);
  missionDecorationMeshes.push(label);
}

function buildMissionEnvironment() {
  addStartMarker();
  if (activeMission.theme !== "maze" && activeMission.showGuidePath !== false) buildMazeGuidePath(activeMission.guidePath || []);
  const environment = activeMission.environment || "delivery";
  if (environment === "delivery") buildDeliveryEnvironment();
  if (environment === "campus") buildCampusEnvironment();
  if (environment === "warehouse") buildWarehouseEnvironment();
  if (environment === "training") buildTrainingEnvironment();
  if (environment === "objectTraining") buildObjectTrainingEnvironment();
  if (environment === "harbor") buildHarborEnvironment();
  if (environment === "guangyang") buildGuangyangEnvironment();
  if (environment === "city") buildCityEnvironment();
  if (environment === "canyon") buildCanyonEnvironment();
  if (environment === "maze") buildMazeEnvironment();
}

function addGuangyangRoadSegment(start, end, width, materials) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const length = Math.hypot(dx, dz);
  if (length < 0.01) return;
  const rotation = -Math.atan2(dz, dx);
  const x = (start[0] + end[0]) / 2;
  const z = (start[1] + end[1]) / 2;
  const shoulder = new THREE.Mesh(new THREE.BoxGeometry(length + 0.08, 0.035, width + 0.28), materials.shoulder);
  shoulder.position.set(x, 0.052, z);
  shoulder.rotation.y = rotation;
  addMissionDecoration(shoulder, null, false);
  const road = new THREE.Mesh(new THREE.BoxGeometry(length + 0.06, 0.045, width), materials.road);
  road.position.set(x, 0.077, z);
  road.rotation.y = rotation;
  road.receiveShadow = true;
  addMissionDecoration(road, null, false);
  const centerLine = new THREE.Mesh(new THREE.BoxGeometry(length, 0.018, 0.065), materials.centerLine);
  centerLine.position.set(x, 0.11, z);
  centerLine.rotation.y = rotation;
  centerLine.renderOrder = 4;
  addMissionDecoration(centerLine, null, false);
}

function addGuangyangRoadNetwork(config) {
  const materials = {
    shoulder: new THREE.MeshStandardMaterial({ color: "#e2e8f0", roughness: 0.86 }),
    road: new THREE.MeshStandardMaterial({ color: "#424751", roughness: 0.92, metalness: 0.02 }),
    centerLine: new THREE.MeshBasicMaterial({ color: "#f3ce46" })
  };
  const junctions = new Map();
  (config.roads || []).forEach(road => {
    const width = Number(road.width) || 2.25;
    for (let index = 0; index < road.points.length - 1; index += 1) {
      addGuangyangRoadSegment(road.points[index], road.points[index + 1], width, materials);
    }
    road.points.forEach(point => {
      const key = `${point[0].toFixed(2)},${point[1].toFixed(2)}`;
      const previous = junctions.get(key);
      if (!previous || width > previous.width) junctions.set(key, { point, width });
    });
  });
  junctions.forEach(({ point, width }) => {
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry((width + 0.28) / 2, (width + 0.28) / 2, 0.035, 28), materials.shoulder);
    shoulder.position.set(point[0], 0.052, point[1]);
    addMissionDecoration(shoulder, null, false);
    const road = new THREE.Mesh(new THREE.CylinderGeometry(width / 2, width / 2, 0.046, 28), materials.road);
    road.position.set(point[0], 0.078, point[1]);
    road.receiveShadow = true;
    addMissionDecoration(road, null, false);
  });
}

function addGuangyangLandmark(landmark, index) {
  const radius = landmark.water ? 1.05 : 0.92 + (index % 3) * 0.12;
  const patch = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 1.06, landmark.water ? 0.035 : 0.045, 28),
    new THREE.MeshStandardMaterial({
      color: landmark.color,
      roughness: landmark.water ? 0.24 : 0.86,
      metalness: landmark.water ? 0.18 : 0.01,
      transparent: true,
      opacity: 0.94
    })
  );
  patch.position.set(landmark.position[0], landmark.water ? 0.065 : 0.052, landmark.position[1]);
  addMissionDecoration(patch, null, false);
  if (!landmark.water) {
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.38 + (index % 2) * 0.15, 0.42),
      new THREE.MeshStandardMaterial({ color: index % 2 ? "#f0c6a3" : "#d7e4b8", roughness: 0.72 })
    );
    marker.position.set(landmark.position[0], 0.25, landmark.position[1]);
    addMissionDecoration(marker);
  }
  const label = createTextLabel(landmark.label, landmark.position[0], landmark.position[1] + radius + 0.38, 0.34);
  label.scale.set(0.9, 0.32, 1);
  missionDecorationMeshes.push(label);
}

function addGuangyangTrafficLight(light) {
  const direction = light.direction || [1, 0];
  const normal = [-direction[1], direction[0]];
  const group = new THREE.Group();
  const poleMaterial = new THREE.MeshStandardMaterial({ color: "#334155", metalness: 0.5, roughness: 0.36 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 1.15, 12), poleMaterial);
  pole.position.y = 0.58;
  group.add(pole);
  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(0.32, 0.82, 0.26),
    new THREE.MeshStandardMaterial({ color: "#111827", roughness: 0.55 })
  );
  housing.position.y = 1.28;
  group.add(housing);
  const lamps = {};
  [["red", "#ef4444", 1.52], ["yellow", "#facc15", 1.28], ["green", "#22c55e", 1.04]].forEach(([state, color, y]) => {
    const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.08, roughness: 0.28 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.095, 16, 12), material);
    lamp.position.set(0, y, -0.14);
    group.add(lamp);
    lamps[state] = lamp;
  });
  group.position.set(light.position[0] + normal[0] * 1.25, 0, light.position[1] + normal[1] * 1.25);
  addMissionDecoration(group);
  competitionTrafficLightVisuals.push({ config: light, lamps });

  if (Array.isArray(light.stopLine) && light.stopLine.length === 2) {
    const [start, end] = light.stopLine;
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(Math.hypot(dx, dz), 0.018, 0.12),
      new THREE.MeshBasicMaterial({ color: "#f8fafc" })
    );
    line.position.set((start[0] + end[0]) / 2, 0.115, (start[1] + end[1]) / 2);
    line.rotation.y = -Math.atan2(dz, dx);
    line.renderOrder = 5;
    addMissionDecoration(line, null, false);
  }
}

function addGuangyangSpeedZone(zone) {
  if (!Array.isArray(zone?.center) || !Number.isFinite(Number(zone.radius))) return;
  const radius = Math.max(0.15, Number(zone.radius));
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.04, radius - 0.09), radius, 64),
    new THREE.MeshBasicMaterial({ color: "#fb923c", transparent: true, opacity: 0.82, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(Number(zone.center[0]), 0.126, Number(zone.center[1]));
  ring.renderOrder = 6;
  addMissionDecoration(ring, null, false);
  const label = createTextLabel(
    `限速 ≤ ${Number(zone.speedLimit).toFixed(2)}`,
    Number(zone.center[0]),
    Number(zone.center[1]) + radius + 0.28,
    0.42
  );
  label.scale.set(0.98, 0.34, 1);
  missionDecorationMeshes.push(label);
}

function createGuangyangTerrainMesh(config, canvas, texture) {
  if (!config?.world || !canvas || !texture || !guangyangReliefRoot) return null;
  const width = Number(config.world.width) || Number(config.world.sourceImage?.widthUnits) || 40;
  const depth = Number(config.world.depth) || Number(config.world.sourceImage?.heightUnits) || 24;
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
  const pixelIndex = (row, column) => {
    const px = Math.min(canvas.width - 1, Math.max(0, Math.round(column / segmentsX * (canvas.width - 1))));
    const py = Math.min(canvas.height - 1, Math.max(0, Math.round(row / segmentsZ * (canvas.height - 1))));
    return (py * canvas.width + px) * 4;
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const offset = pixelIndex(row, column);
      const r = sourcePixels[offset];
      const g = sourcePixels[offset + 1];
      const b = sourcePixels[offset + 2];
      const maximum = Math.max(r, g, b, 1);
      const saturation = (maximum - Math.min(r, g, b)) / maximum;
      weakWater[index] = Number(saturation > 0.18 && b > 55 && b > r * 1.06 && b >= g * 0.97);
      strongWater[index] = Number(saturation > 0.28 && b > 68 && b > r * 1.15 && b > g * 1.02);
      terrainBumps[index] = Math.max(0, Math.min(0.026, (g - Math.max(r * 1.02, b * 0.92)) / 90 * 0.026));
      const inSeedRim = row <= 2 || row >= segmentsZ - 2 || column <= 2 || column >= segmentsX - 2;
      if (inSeedRim && strongWater[index]) {
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
  for (let row = 0; row < rows; row += 1) {
    exteriorWater[row * columns] = 1;
    exteriorWater[row * columns + segmentsX] = 1;
  }
  for (let column = 0; column < columns; column += 1) {
    exteriorWater[column] = 1;
    exteriorWater[segmentsZ * columns + column] = 1;
  }

  const roadGeometry = globalThis.CompetitionCore?.geometry;
  const roadSurface = new Uint8Array(total);
  const heights = new Float32Array(total);
  for (let row = 0; row < rows; row += 1) {
    const worldZ = row / segmentsZ * depth - depth / 2;
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const worldX = column / segmentsX * width - width / 2;
      roadSurface[index] = Number((config.roads || []).some(road => {
        const distance = roadGeometry?.distanceToPolyline?.([worldX, worldZ], road.points)?.distance;
        return Number.isFinite(distance) && distance <= (Number(road.width) || 0) / 2 + 0.36;
      }));
      heights[index] = exteriorWater[index] && !roadSurface[index] ? 0 : 1;
    }
  }
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Float32Array(total);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        if (roadSurface[index]) {
          next[index] = 1;
          continue;
        }
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

  const geometry = new THREE.PlaneGeometry(width, depth, segmentsX, segmentsZ);
  const positions = geometry.getAttribute("position");
  for (let index = 0; index < total; index += 1) {
    const value = roadSurface[index] ? 1 : heights[index] * heights[index] * (3 - 2 * heights[index]);
    const surfaceBump = value > 0.82 && !roadSurface[index] ? terrainBumps[index] : 0;
    positions.setZ(index, value * GUANGYANG_TERRAIN_DROP + surfaceBump);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const terrain = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ map: texture, color: "#ffffff", side: THREE.FrontSide, fog: false, toneMapped: false })
  );
  terrain.name = "guangyang-source-terrain";
  terrain.rotation.x = -Math.PI / 2;
  terrain.position.y = 0.098 - GUANGYANG_TERRAIN_DROP;
  terrain.renderOrder = 2;
  terrain.castShadow = false;
  terrain.receiveShadow = false;
  terrain.userData.visualOnly = true;
  terrain.userData.exteriorWaterRatio = queueEnd / total;
  guangyangReliefRoot.add(terrain);
  guangyangTerrainMesh = terrain;
  updateGuangyangReliefVisibility();
  return terrain;
}

function loadGuangyangSourceImage(imageUrl) {
  const cacheKey = String(imageUrl || "");
  const cached = guangyangSourceImagePromises.get(cacheKey);
  if (cached) return cached;
  const pending = new Promise((resolve, reject) => {
    new THREE.ImageLoader().load(cacheKey, resolve, undefined, reject);
  });
  guangyangSourceImagePromises.set(cacheKey, pending);
  pending.catch(() => {
    if (guangyangSourceImagePromises.get(cacheKey) === pending) {
      guangyangSourceImagePromises.delete(cacheKey);
    }
  });
  return pending;
}

function addGuangyangSourceMap(config) {
  const source = config.world?.sourceImage;
  const crop = source?.crop;
  if (!source?.path || !crop) return null;
  const buildGeneration = missionBuildGeneration;
  const material = new THREE.MeshBasicMaterial({ color: "#dbeafe", side: THREE.DoubleSide, fog: false, toneMapped: false });
  const mapPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(Number(source.widthUnits) || 50, Number(source.heightUnits) || 30),
    material
  );
  mapPlane.rotation.x = -Math.PI / 2;
  mapPlane.position.y = 0.098;
  mapPlane.renderOrder = 2;
  addMissionDecoration(mapPlane, null, false);
  guangyangFlatMapPlane = mapPlane;

  const textureUrl = new URL(source.path, document.baseURI).href;
  const ready = loadGuangyangSourceImage(textureUrl).then(sourceImage => {
    if (buildGeneration !== missionBuildGeneration || !mapPlane.parent) {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(Number(crop.width)));
    canvas.height = Math.max(1, Math.round(Number(crop.height)));
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(
      sourceImage,
      Number(crop.x), Number(crop.y), Number(crop.width), Number(crop.height),
      0, 0, canvas.width, canvas.height
    );
    const patch = source.bakedVehiclePatch;
    if (patch?.source && patch?.target) {
      context.drawImage(
        sourceImage,
        Number(patch.source.x), Number(patch.source.y), Number(patch.source.width), Number(patch.source.height),
        Number(patch.target.x) - Number(crop.x), Number(patch.target.y) - Number(crop.y),
        Number(patch.target.width), Number(patch.target.height)
      );
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    material.color.set("#ffffff");
    material.map = texture;
    material.needsUpdate = true;
    try {
      createGuangyangTerrainMesh(config, canvas, texture);
    } catch (error) {
      throw new Error(`广阳岛地形层生成失败：${error.message || error}`);
    }
    markSceneShadowDirty();
  }).catch(error => {
    if (buildGeneration !== missionBuildGeneration) return;
    material.color.set("#2f75a9");
    addLog("广阳岛原图纹理加载失败，请检查 word/广阳岛仿真沙盘地图.png。", false);
    throw new Error(`广阳岛视觉资源加载失败：${error.message || error}`);
  });
  simulationSceneReadyPromise = Promise.all([simulationSceneReadyPromise, ready]);
  // UI startup may precede the first awaited capture. Preserve the rejection
  // for ensureSimulationSceneReady without creating an unhandled rejection.
  void simulationSceneReadyPromise.catch(() => {});
  return mapPlane;
}

const GUANGYANG_RELIEF_BASE_Y = 0.112;
const GUANGYANG_RELIEF_SPEC = {
  treeClusters: [
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
    [337, 725, 47, 48, 14, "green"], [468, 772, 78, 23, 18, "light"],
    [905, 764, 76, 24, 17, "light"], [1082, 686, 96, 30, 18, "green"],
    [1186, 592, 38, 60, 13, "dark"], [428, 648, 52, 38, 17, "gold"]
  ],
  buildings: [
    { anchor: [458, 134], sizePx: [82, 25], height: 0.46, roof: "#6f9f92", wall: "#d9e5cf" },
    { anchor: [640, 102], sizePx: [28, 38], height: 0.58 },
    { anchor: [704, 99], sizePx: [62, 30], height: 0.52 },
    { anchor: [669, 158], sizePx: [25, 48], height: 0.68 },
    { anchor: [746, 137], sizePx: [25, 42], height: 0.61 },
    { anchor: [782, 130], sizePx: [32, 28], height: 0.42 },
    { anchor: [1113, 58], sizePx: [42, 42], height: 0.86, style: "pagoda" },
    { anchor: [1210, 176], sizePx: [52, 28], height: 0.36, roof: "#537568" },
    { anchor: [1160, 235], sizePx: [24, 18], height: 0.3, style: "tent" },
    { anchor: [1208, 305], sizePx: [25, 20], height: 0.3, style: "tent" },
    { anchor: [1182, 352], sizePx: [27, 20], height: 0.3, style: "tent" },
    { anchor: [676, 470], sizePx: [28, 28], height: 0.4 },
    { anchor: [720, 465], sizePx: [42, 30], height: 0.5 },
    { anchor: [778, 510], sizePx: [34, 25], height: 0.38 },
    { anchor: [894, 635], sizePx: [26, 22], height: 0.32, style: "tent" },
    { anchor: [930, 647], sizePx: [30, 24], height: 0.36, roof: "#6f9f92" }
  ],
  lakes: [
    { anchor: [998, 214], sizePx: [96, 60] },
    { anchor: [738, 325], sizePx: [132, 45] },
    { anchor: [475, 482], sizePx: [112, 43] }
  ],
  fields: [
    { anchor: [991, 386], sizePx: [152, 60], count: 150, kind: "rapeseed" },
    { anchor: [1035, 535], sizePx: [170, 86], count: 130, kind: "pink" }
  ],
  signs: [
    { anchor: [592, 109], kind: "parking", heading: 0 },
    { anchor: [649, 334], kind: "straight", heading: 0 },
    { anchor: [846, 309], kind: "turn-right", heading: -0.3 },
    { anchor: [237, 455], kind: "turn-left", heading: 0.25 },
    { anchor: [994, 745], kind: "slow", heading: Math.PI }
  ]
};

function guangyangPixelToWorld(config, pixel) {
  const source = config?.world?.sourceImage;
  const crop = source?.crop;
  if (!source || !crop || !Array.isArray(pixel)) return [0, 0];
  const scaleX = Number(source.widthUnits) / Number(crop.width);
  const scaleZ = Number(source.heightUnits) / Number(crop.height);
  return [
    (Number(pixel[0]) - Number(crop.x) - Number(crop.width) / 2) * scaleX,
    (Number(pixel[1]) - Number(crop.y) - Number(crop.height) / 2) * scaleZ
  ];
}

function guangyangPixelSize(config, sizePx) {
  const source = config?.world?.sourceImage;
  const crop = source?.crop;
  return [
    Number(sizePx[0]) * Number(source.widthUnits) / Number(crop.width),
    Number(sizePx[1]) * Number(source.heightUnits) / Number(crop.height)
  ];
}

function createDeterministicRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function guangyangPixelBlockedByReliefFeature(pixel, margin = 7) {
  const specs = [
    ...GUANGYANG_RELIEF_SPEC.buildings,
    ...GUANGYANG_RELIEF_SPEC.lakes,
    ...GUANGYANG_RELIEF_SPEC.fields,
    ...GUANGYANG_RELIEF_SPEC.signs.map(sign => ({ ...sign, sizePx: [26, 26] }))
  ];
  return specs.some(spec => {
    const width = Number(spec.sizePx?.[0]) || 0;
    const depth = Number(spec.sizePx?.[1]) || 0;
    return Math.abs(Number(pixel[0]) - Number(spec.anchor[0])) <= width / 2 + margin
      && Math.abs(Number(pixel[1]) - Number(spec.anchor[1])) <= depth / 2 + margin;
  });
}

function addGuangyangReliefCurbs(root, config) {
  const roads = config.roads || [];
  const segmentCount = roads.reduce((total, road) => total + Math.max(0, road.points.length - 1), 0) * 2;
  if (!segmentCount) return;
  const endpointUse = new Map();
  const pointKey = point => `${Number(point[0]).toFixed(3)},${Number(point[1]).toFixed(3)}`;
  roads.forEach(road => {
    [road.points[0], road.points[road.points.length - 1]].forEach(point => {
      const key = pointKey(point);
      endpointUse.set(key, (endpointUse.get(key) || 0) + 1);
    });
  });
  const material = new THREE.MeshStandardMaterial({ color: "#f4f2ef", roughness: 0.88 });
  const curbs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, segmentCount);
  const transform = new THREE.Object3D();
  let instance = 0;
  roads.forEach(road => {
    const width = Number(road.width) || 2.25;
    for (let index = 0; index < road.points.length - 1; index += 1) {
      const start = road.points[index];
      const end = road.points[index + 1];
      const dx = end[0] - start[0];
      const dz = end[1] - start[1];
      const length = Math.hypot(dx, dz);
      if (length < 0.01) continue;
      const unitX = dx / length;
      const unitZ = dz / length;
      const trimStart = index === 0 && endpointUse.get(pointKey(start)) > 1 ? Math.min(width * 0.5, length * 0.32) : 0;
      const trimEnd = index === road.points.length - 2 && endpointUse.get(pointKey(end)) > 1
        ? Math.min(width * 0.5, length * 0.32)
        : 0;
      const visibleLength = length - trimStart - trimEnd;
      if (visibleLength < 0.04) continue;
      const normalX = -dz / length;
      const normalZ = dx / length;
      const centerShift = (trimStart - trimEnd) / 2;
      [-1, 1].forEach(side => {
        transform.position.set(
          (start[0] + end[0]) / 2 + unitX * centerShift + normalX * side * (width / 2 + 0.025),
          GUANGYANG_RELIEF_BASE_Y + 0.02,
          (start[1] + end[1]) / 2 + unitZ * centerShift + normalZ * side * (width / 2 + 0.025)
        );
        transform.rotation.set(0, -Math.atan2(dz, dx), 0);
        transform.scale.set(visibleLength + 0.03, 0.04, 0.1);
        transform.updateMatrix();
        curbs.setMatrixAt(instance, transform.matrix);
        instance += 1;
      });
    }
  });
  curbs.count = instance;
  curbs.instanceMatrix.needsUpdate = true;
  curbs.castShadow = false;
  curbs.receiveShadow = true;
  root.add(curbs);
}

function addGuangyangReliefTrees(root, config) {
  const total = GUANGYANG_RELIEF_SPEC.treeClusters.reduce((sum, cluster) => sum + cluster[4], 0);
  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.055, 0.08, 0.42, 7),
    new THREE.MeshStandardMaterial({ color: "#6b4a32", roughness: 0.9 }),
    total
  );
  const crowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.34, 1),
    new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.78 }),
    total
  );
  const crownHighlights = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.22, 1),
    new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.74 }),
    total
  );
  const palettes = {
    green: ["#386d43", "#5f9e4d", "#78b85b", "#a5d46f"],
    dark: ["#2f623d", "#487f42", "#6ca24c"],
    light: ["#6ca94f", "#8bc45b", "#b6dc78"],
    gold: ["#78994c", "#b9b64f", "#d5c85b", "#dfa94b"]
  };
  const transform = new THREE.Object3D();
  let instance = 0;
  GUANGYANG_RELIEF_SPEC.treeClusters.forEach((cluster, clusterIndex) => {
    const [centerX, centerY, radiusX, radiusY, count, paletteName] = cluster;
    const random = createDeterministicRandom(20260818 + clusterIndex * 977);
    let placed = 0;
    let attempts = 0;
    while (placed < count && attempts < count * 16) {
      attempts += 1;
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random());
      const sourcePoint = [
        centerX + Math.cos(angle) * radiusX * radius,
        centerY + Math.sin(angle) * radiusY * radius
      ];
      if (guangyangPixelBlockedByReliefFeature(sourcePoint)) continue;
      const [x, z] = guangyangPixelToWorld(config, sourcePoint);
      const roadGeometry = globalThis.CompetitionCore?.geometry;
      const roadTooClose = (config.roads || []).some(road => {
        const distance = roadGeometry?.distanceToPolyline?.([x, z], road.points)?.distance;
        return Number.isFinite(distance) && distance <= (Number(road.width) || 0) / 2 + 0.48;
      });
      if (roadTooClose) continue;
      const scale = 0.7 + random() * 0.55;
      transform.position.set(x, GUANGYANG_RELIEF_BASE_Y + 0.21 * scale, z);
      transform.rotation.set(0, random() * Math.PI * 2, 0);
      transform.scale.set(scale, scale, scale);
      transform.updateMatrix();
      trunk.setMatrixAt(instance, transform.matrix);
      transform.position.y = GUANGYANG_RELIEF_BASE_Y + 0.62 * scale;
      transform.scale.set(scale * (0.88 + random() * 0.22), scale * (0.82 + random() * 0.2), scale);
      transform.updateMatrix();
      crowns.setMatrixAt(instance, transform.matrix);
      const palette = palettes[paletteName] || palettes.green;
      const treeColor = new THREE.Color(palette[Math.floor(random() * palette.length)]);
      crowns.setColorAt(instance, treeColor);
      const highlightAngle = instance * 2.3999632297;
      transform.position.set(
        x + Math.cos(highlightAngle) * 0.085 * scale,
        GUANGYANG_RELIEF_BASE_Y + 0.8 * scale,
        z + Math.sin(highlightAngle) * 0.085 * scale
      );
      transform.rotation.set(0, highlightAngle, 0);
      transform.scale.set(scale * 0.72, scale * 0.62, scale * 0.72);
      transform.updateMatrix();
      crownHighlights.setMatrixAt(instance, transform.matrix);
      crownHighlights.setColorAt(instance, treeColor.clone().lerp(new THREE.Color("#dff3b2"), 0.26));
      instance += 1;
      placed += 1;
    }
  });
  trunk.count = instance;
  crowns.count = instance;
  crownHighlights.count = instance;
  trunk.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  crownHighlights.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  if (crownHighlights.instanceColor) crownHighlights.instanceColor.needsUpdate = true;
  trunk.castShadow = false;
  crowns.castShadow = false;
  crownHighlights.castShadow = false;
  trunk.receiveShadow = true;
  crowns.receiveShadow = true;
  crownHighlights.receiveShadow = true;
  root.add(trunk, crowns, crownHighlights);
}

function addGuangyangReliefBuilding(root, config, spec) {
  const [x, z] = guangyangPixelToWorld(config, spec.anchor);
  const [width, depth] = guangyangPixelSize(config, spec.sizePx);
  const height = Number(spec.height) || 0.45;
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = Number(spec.rotation) || 0;
  if (spec.style === "pagoda") {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(width * 0.28, width * 0.34, height * 0.34, 8),
      new THREE.MeshStandardMaterial({ color: "#e9d1b9", roughness: 0.78 })
    );
    base.position.y = GUANGYANG_RELIEF_BASE_Y + height * 0.17;
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(width * 0.5, height * 0.38, 8),
      new THREE.MeshStandardMaterial({ color: "#d99290", roughness: 0.72 })
    );
    roof.position.y = GUANGYANG_RELIEF_BASE_Y + height * 0.53;
    group.add(base, roof);
  } else if (spec.style === "tent") {
    const tent = new THREE.Mesh(
      new THREE.ConeGeometry(Math.max(width, depth) * 0.52, height, 4),
      new THREE.MeshStandardMaterial({ color: spec.roof || "#e9b0ae", roughness: 0.86 })
    );
    tent.rotation.y = Math.PI / 4;
    tent.scale.z = Math.max(0.55, depth / Math.max(width, 0.01));
    tent.position.y = GUANGYANG_RELIEF_BASE_Y + height / 2;
    group.add(tent);
  } else {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.88, height * 0.68, depth * 0.88),
      new THREE.MeshStandardMaterial({ color: spec.wall || "#e9d1b9", roughness: 0.82 })
    );
    body.position.y = GUANGYANG_RELIEF_BASE_Y + height * 0.34;
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(1, height * 0.42, 4),
      new THREE.MeshStandardMaterial({ color: spec.roof || "#e9b0ae", roughness: 0.76 })
    );
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(width * 0.66, 1, depth * 0.66);
    roof.position.y = GUANGYANG_RELIEF_BASE_Y + height * 0.78;
    group.add(body, roof);
  }
  group.traverse(node => {
    if (!node.isMesh) return;
    node.castShadow = false;
    node.receiveShadow = true;
  });
  root.add(group);
}

function addGuangyangReliefLakes(root, config) {
  const material = new THREE.MeshStandardMaterial({
    color: "#83bcc5", metalness: 0.08, roughness: 0.2, transparent: true, opacity: 0.3,
    side: THREE.DoubleSide, depthWrite: false
  });
  GUANGYANG_RELIEF_SPEC.lakes.forEach(spec => {
    const [x, z] = guangyangPixelToWorld(config, spec.anchor);
    const [width, depth] = guangyangPixelSize(config, spec.sizePx);
    const lake = new THREE.Mesh(new THREE.CircleGeometry(1, 48), material);
    lake.rotation.x = -Math.PI / 2;
    lake.position.set(x, GUANGYANG_RELIEF_BASE_Y + 0.012, z);
    lake.scale.set(width / 2, depth / 2, 1);
    lake.renderOrder = 4;
    root.add(lake);
  });
}

function addGuangyangReliefFields(root, config) {
  GUANGYANG_RELIEF_SPEC.fields.forEach((spec, fieldIndex) => {
    const [x, z] = guangyangPixelToWorld(config, spec.anchor);
    const [width, depth] = guangyangPixelSize(config, spec.sizePx);
    const isPink = spec.kind === "pink";
    const base = new THREE.Mesh(
      new THREE.CircleGeometry(1, 56),
      new THREE.MeshStandardMaterial({
        color: isPink ? "#d996ae" : "#e7b943", roughness: 0.82,
        transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false
      })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.set(x, GUANGYANG_RELIEF_BASE_Y + 0.014, z);
    base.scale.set(width / 2, depth / 2, 1);
    root.add(base);
    const geometry = isPink ? new THREE.ConeGeometry(0.045, 0.2, 5) : new THREE.IcosahedronGeometry(0.045, 0);
    const accents = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: isPink ? "#eab5c7" : "#f5d65c", roughness: 0.72 }),
      spec.count
    );
    const random = createDeterministicRandom(42000 + fieldIndex * 211);
    const transform = new THREE.Object3D();
    for (let index = 0; index < spec.count; index += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * 0.92;
      transform.position.set(
        x + Math.cos(angle) * width * 0.5 * radius,
        GUANGYANG_RELIEF_BASE_Y + (isPink ? 0.11 : 0.075),
        z + Math.sin(angle) * depth * 0.5 * radius
      );
      const scale = 0.7 + random() * 0.7;
      transform.rotation.set(0, random() * Math.PI * 2, 0);
      transform.scale.set(scale, scale, scale);
      transform.updateMatrix();
      accents.setMatrixAt(index, transform.matrix);
    }
    accents.instanceMatrix.needsUpdate = true;
    accents.castShadow = false;
    root.add(accents);
  });
}

function addGuangyangReliefTerraces(root, config) {
  const [x, z] = guangyangPixelToWorld(config, [692, 686]);
  const [width, depth] = guangyangPixelSize(config, [205, 185]);
  const colors = ["#d5d99d", "#c8d58a", "#bace78", "#afcb69", "#9fbd62", "#91ad59"];
  colors.forEach((color, index) => {
    const ratio = 1 - index * 0.115;
    const layerHeight = 0.045 * (index + 1);
    const layer = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1.04, layerHeight, 48),
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, transparent: true, opacity: 0.78 })
    );
    layer.scale.set(width * 0.5 * ratio, 1, depth * 0.5 * ratio);
    layer.position.set(x + index * 0.05, GUANGYANG_RELIEF_BASE_Y + layerHeight / 2, z - index * 0.04);
    layer.receiveShadow = true;
    root.add(layer);
  });
}

function addGuangyangReliefRocks(root, config) {
  const [centerX, centerZ] = guangyangPixelToWorld(config, [455, 318]);
  const [width, depth] = guangyangPixelSize(config, [145, 50]);
  const rocks = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.17, 0),
    new THREE.MeshStandardMaterial({ color: "#6f7b70", roughness: 0.96 }),
    16
  );
  const random = createDeterministicRandom(93751);
  const transform = new THREE.Object3D();
  for (let index = 0; index < 16; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random());
    const scale = 0.6 + random() * 1.25;
    transform.position.set(
      centerX + Math.cos(angle) * width * 0.5 * radius,
      GUANGYANG_RELIEF_BASE_Y + 0.18 * scale,
      centerZ + Math.sin(angle) * depth * 0.5 * radius
    );
    transform.rotation.set(random(), random() * Math.PI, random());
    transform.scale.set(scale, scale * 0.72, scale);
    transform.updateMatrix();
    rocks.setMatrixAt(index, transform.matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  rocks.castShadow = false;
  rocks.receiveShadow = true;
  root.add(rocks);
}

function createGuangyangSignTexture(kind) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 128, 128);
  context.textAlign = "center";
  context.textBaseline = "middle";
  if (kind === "slow") {
    context.beginPath();
    context.moveTo(64, 9);
    context.lineTo(117, 110);
    context.lineTo(11, 110);
    context.closePath();
    context.fillStyle = "#f5c31b";
    context.fill();
    context.lineWidth = 8;
    context.strokeStyle = "#111111";
    context.stroke();
    context.fillStyle = "#111111";
    context.font = "700 46px Microsoft YaHei, sans-serif";
    context.fillText("慢", 64, 72);
  } else {
    context.fillStyle = "#0756c7";
    if (kind === "parking") context.fillRect(10, 10, 108, 108);
    else {
      context.beginPath();
      context.arc(64, 64, 55, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = "#ffffff";
    if (kind === "parking") {
      context.font = "700 78px Arial";
      context.fillText("P", 64, 67);
    } else {
      context.lineWidth = 13;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = "#ffffff";
      context.beginPath();
      if (kind === "straight") {
        context.moveTo(64, 98); context.lineTo(64, 30); context.lineTo(42, 52);
        context.moveTo(64, 30); context.lineTo(86, 52);
      } else if (kind === "turn-left") {
        context.moveTo(91, 91); context.lineTo(91, 63); context.quadraticCurveTo(91, 42, 69, 42); context.lineTo(37, 42);
        context.moveTo(37, 42); context.lineTo(57, 23); context.moveTo(37, 42); context.lineTo(57, 61);
      } else {
        context.moveTo(37, 91); context.lineTo(37, 63); context.quadraticCurveTo(37, 42, 59, 42); context.lineTo(91, 42);
        context.moveTo(91, 42); context.lineTo(71, 23); context.moveTo(91, 42); context.lineTo(71, 61);
      }
      context.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function addGuangyangReliefSigns(root, config) {
  const poleMaterial = new THREE.MeshStandardMaterial({ color: "#3f4752", metalness: 0.52, roughness: 0.42 });
  GUANGYANG_RELIEF_SPEC.signs.forEach(spec => {
    const [x, z] = guangyangPixelToWorld(config, spec.anchor);
    const group = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.032, 0.58, 8), poleMaterial);
    pole.position.y = GUANGYANG_RELIEF_BASE_Y + 0.29;
    pole.castShadow = false;
    group.add(pole);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.kind === "parking" ? 0.4 : 0.46, 0.46),
      new THREE.MeshBasicMaterial({ map: createGuangyangSignTexture(spec.kind), transparent: true, side: THREE.DoubleSide })
    );
    panel.position.y = GUANGYANG_RELIEF_BASE_Y + 0.68;
    group.add(panel);
    group.position.set(x, 0, z);
    group.rotation.y = Number(spec.heading) || 0;
    root.add(group);
  });
}

function buildGuangyangRelief(config) {
  if (!config?.world?.sourceImage) return null;
  const root = new THREE.Group();
  root.name = "guangyang-relief";
  root.userData.kind = "guangyang-relief";
  root.userData.visualOnly = true;
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(Number(config.world.width) || 40, Number(config.world.depth) || 24),
    new THREE.ShadowMaterial({ color: "#10243a", transparent: true, opacity: 0.13, depthWrite: false })
  );
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = GUANGYANG_RELIEF_BASE_Y - 0.005;
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = 3;
  root.add(shadowCatcher);
  addGuangyangReliefLakes(root, config);
  addGuangyangReliefTrees(root, config);
  GUANGYANG_RELIEF_SPEC.buildings.forEach(spec => addGuangyangReliefBuilding(root, config, spec));
  addGuangyangReliefFields(root, config);
  addGuangyangReliefTerraces(root, config);
  addGuangyangReliefRocks(root, config);
  addGuangyangReliefSigns(root, config);
  guangyangReliefRoot = root;
  addMissionDecoration(root, null, false);
  updateGuangyangReliefVisibility();
  return root;
}

function updateGuangyangReliefVisibility() {
  const active = activeMission?.environment === "guangyang";
  const reliefVisible = active && cameraMode !== "top";
  let changed = false;
  if (guangyangReliefRoot && guangyangReliefRoot.visible !== reliefVisible) {
    guangyangReliefRoot.visible = reliefVisible;
    changed = true;
  }
  const flatMapVisible = active && (!reliefVisible || !guangyangTerrainMesh);
  if (guangyangFlatMapPlane && guangyangFlatMapPlane.visible !== flatMapVisible) {
    guangyangFlatMapPlane.visible = flatMapVisible;
    changed = true;
  }
  if (changed) markSceneShadowDirty();
}

function buildGuangyangEnvironment() {
  const config = currentGuangyangSceneConfig();
  if (!config) return;
  addGuangyangSourceMap(config);
  buildGuangyangRelief(config);
  (config.trafficLights || []).forEach(addGuangyangTrafficLight);
  missionCheckpointPositions = (config.checkpoints || []).map(checkpoint => [...checkpoint.position]);
  const checkpointColors = ["#22d3ee", "#a78bfa", "#f59e0b", "#ec4899"];
  missionCheckpointPositions.forEach((position, index) => createMazeCheckpoint(position, index, checkpointColors[index % checkpointColors.length]));
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

function buildObjectTrainingEnvironment() {
  // Keep the calibration field free of decorative red/orange cones: those
  // colors are official target/cleanup visual classes and would create false
  // detections in the robot-mounted camera.
  addFloorDecal(0, 0, 7.8, 0.06, "#67e8f9", 0.18);
  addFloorDecal(0, 0, 0.06, 9.6, "#67e8f9", 0.12);
  if (activeMission.goal) {
    addZoneLabel(activeMission.goalLabel || "训练终点", activeMission.goal, activeMission.goalColor || "#22c55e");
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
    color: "#e0f2fe", emissive: "#38bdf8", emissiveIntensity: 1.2, roughness: 0.28
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
      const instanceIndex = index * 2 + sideIndex;
      setBoxInstance(longPanelInstances, instanceIndex, x, baseHeight + height / 2, z + side * (h / 2 - panelThickness / 2), Math.max(0.18, w - 0.12), height, panelThickness);
      setBoxInstance(endPanelInstances, instanceIndex, x + side * (w / 2 - panelThickness / 2), baseHeight + height / 2, z, panelThickness, height, Math.max(0.18, h - 0.12));
      setBoxInstance(longRailInstances, instanceIndex, x, baseHeight + height + 0.045, z + side * (h / 2 - 0.04), w + 0.04, 0.09, 0.18);
      setBoxInstance(endRailInstances, instanceIndex, x + side * (w / 2 - 0.04), baseHeight + height + 0.045, z, 0.18, 0.09, h + 0.04);
      longPanelInstances.setColorAt(instanceIndex, panelColor);
      endPanelInstances.setColorAt(instanceIndex, panelColor);
    });
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([xSide, zSide], cornerIndex) => {
      setBoxInstance(postInstances, index * 4 + cornerIndex,
        x + xSide * (w / 2 - 0.08), baseHeight + (height + 0.16) / 2,
        z + zSide * (h / 2 - 0.08), 0.18, height + 0.16, 0.18);
    });
    const longSeamCount = Math.max(1, Math.floor(w / 0.82) - 1);
    for (let seamIndex = 1; seamIndex <= longSeamCount; seamIndex++) {
      const seamX = x - w / 2 + (w * seamIndex) / (longSeamCount + 1);
      [-1, 1].forEach(side => seamTransforms.push({
        x: seamX, y: baseHeight + height * 0.52, z: z + side * (h / 2 + 0.012),
        w: 0.018, h: height * 0.76, d: 0.026
      }));
    }
    const endSeamCount = Math.max(1, Math.floor(h / 0.82) - 1);
    for (let seamIndex = 1; seamIndex <= endSeamCount; seamIndex++) {
      const seamZ = z - h / 2 + (h * seamIndex) / (endSeamCount + 1);
      [-1, 1].forEach(side => seamTransforms.push({
        x: x + side * (w / 2 + 0.012), y: baseHeight + height * 0.52, z: seamZ,
        w: 0.026, h: height * 0.76, d: 0.018
      }));
    }
  });
  const seamInstances = new THREE.InstancedMesh(unitBox(), seamMaterial, seamTransforms.length);
  seamTransforms.forEach((seam, index) => setBoxInstance(seamInstances, index, seam.x, seam.y, seam.z, seam.w, seam.h, seam.d));
  const meshes = [foundationInstances, longPanelInstances, endPanelInstances, longRailInstances, endRailInstances, postInstances, seamInstances];
  meshes.forEach(mesh => {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere?.();
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

function addObjectTaskZoneMarker(zone) {
  const role = normalizeGuangyangObjectRole(zone?.role ?? zone?.category);
  if (role !== "storage" && role !== "cleanup" && role !== "offroad-removal") return null;
  const x = Number(zone.position?.[0] ?? zone.x);
  const z = Number(zone.position?.[1] ?? zone.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const meta = GUANGYANG_OBJECT_ROLE_META[role];
  const color = /^#[0-9a-f]{6}$/i.test(String(zone.color || "")) ? String(zone.color) : meta.color;
  // Ground guidance is deliberately neutral. Even very pale role hues can be
  // pushed back into the frozen green/orange predicates by lighting and tone
  // mapping, joining the pad to the post in the camera image. Only the upright
  // solid sign is an official camera signature.
  const guidanceColor = "#e2e8f0";
  const radius = Math.max(0.2, Math.min(5, Number(zone.radius) || 0.95));
  const group = new THREE.Group();
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(Math.max(0.08, radius - 0.04), 48),
    new THREE.MeshBasicMaterial({ color: guidanceColor, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false })
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 0.012;
  fill.userData.hideFromVirtualCamera = true;
  group.add(fill);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.08, radius - 0.055), radius, 48),
    new THREE.MeshBasicMaterial({ color: guidanceColor, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.018;
  ring.renderOrder = 7;
  ring.userData.hideFromVirtualCamera = true;
  group.add(ring);
  const sign = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 0.72, 14),
    new THREE.MeshBasicMaterial({ color, toneMapped: false })
  );
  sign.position.y = 0.43;
  sign.userData.kind = "vision-zone-sign";
  sign.userData.objectCategory = meta.category;
  if (role === "offroad-removal") sign.userData.hideFromVirtualCamera = true;
  group.add(sign);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 0.05, 20),
    new THREE.MeshStandardMaterial({ color: "#e2e8f0", metalness: 0.28, roughness: 0.42 })
  );
  cap.position.y = 0.81;
  group.add(cap);
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.34, 1.35, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: guidanceColor, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false })
  );
  beacon.position.y = 0.72;
  beacon.userData.hideFromVirtualCamera = true;
  group.add(beacon);
  // The guidance light is deliberately neutral. A category-colored light can
  // tint the floor into one large detector component at close range.
  const glow = new THREE.PointLight("#ffffff", 0.2, 3.2, 2);
  glow.position.y = 0.55;
  glow.userData.hideFromVirtualCamera = true;
  group.add(glow);
  group.position.set(x, activeMission.environment === "guangyang" ? 0.09 : 0, z);
  group.userData.kind = "object-task-zone";
  group.userData.objectRole = role;
  group.userData.objectCategory = meta.category;
  group.userData.zoneId = String(zone.id || `${role}-zone`);
  group.userData.goalPulse = { ring, beacon, glow };
  goalPulseEffects.push(group.userData.goalPulse);
  enableObjectShadows(group);
  fill.castShadow = false;
  ring.castShadow = false;
  beacon.castShadow = false;
  scene.add(group);
  markerMeshes.push(group);
  const label = createTextLabel(zone.label || meta.label, x, z - Math.min(0.72, radius * 0.72), 0.92);
  label.scale.set(1.02, 0.38, 1);
  markerMeshes.push(label);
  return group;
}

function addMarker(pos, kind, color) {
  if (kind !== "goal") return;
  const group = new THREE.Group();
  const mazeGoal = activeMission.theme === "maze";
  const removalZone = activeMission.goalCategory === "清理点";
  const visionZone = ["存放点", "清理点"].includes(activeMission.goalCategory);
  const goalLabel = activeMission.goalLabel || "终点";
  const boundaryColor = visionZone ? "#e2e8f0" : color;
  const pulseColor = visionZone ? boundaryColor : color;
  if (visionZone) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.035, 0.62, 10),
      new THREE.MeshStandardMaterial({ color: "#334155", metalness: 0.45, roughness: 0.5 })
    );
    post.position.y = 0.34;
    group.add(post);
    const categorySign = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.5, 0.05),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.2, roughness: 0.45 })
    );
    categorySign.position.y = 0.82;
    categorySign.userData.objectCategory = normalizeTrainingVisionCategory(activeMission.goalCategory);
    group.add(categorySign);
  }
  const completionSpec = resolveMissionCompletionSpec();
  const visualGoalRadius = completionSpec.type === "delivery" ? completionSpec.deliveryRadius : completionSpec.goalRadius;
  const geometry = mazeGoal ? createStarGeometry(0.62, 0.29, 0.1) : new THREE.CylinderGeometry(0.36, 0.36, 0.06, 28);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: boundaryColor, emissive: boundaryColor, emissiveIntensity: 0.18, metalness: 0.12, roughness: 0.48
  }));
  if (mazeGoal) {
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.09;
  } else {
    mesh.position.y = 0.04;
  }
  mesh.userData.kind = kind;
  if (visionZone) mesh.userData.hideFromVirtualCamera = true;
  group.add(mesh);
  const pulseInner = Math.max(0.08, Math.min(visualGoalRadius - 0.02, visualGoalRadius * 0.82));
  const pulseRing = new THREE.Mesh(
    new THREE.RingGeometry(pulseInner, visualGoalRadius, 40),
    new THREE.MeshBasicMaterial({ color: pulseColor, transparent: true, opacity: 0.68, side: THREE.DoubleSide, depthWrite: false })
  );
  pulseRing.rotation.x = -Math.PI / 2;
  pulseRing.position.y = 0.075;
  if (visionZone) pulseRing.userData.hideFromVirtualCamera = true;
  group.add(pulseRing);
  const boundaryRing = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.05, visualGoalRadius - 0.025), visualGoalRadius, 48),
    new THREE.MeshBasicMaterial({ color: boundaryColor, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false })
  );
  boundaryRing.rotation.x = -Math.PI / 2;
  boundaryRing.position.y = 0.082;
  boundaryRing.renderOrder = 6;
  if (visionZone) boundaryRing.userData.hideFromVirtualCamera = true;
  group.add(boundaryRing);
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(mazeGoal ? 0.22 : 0.16, mazeGoal ? 0.42 : 0.32, mazeGoal ? 1.9 : 1.45, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: boundaryColor, transparent: true, opacity: 0.11, side: THREE.DoubleSide, depthWrite: false })
  );
  beacon.position.y = mazeGoal ? 0.98 : 0.76;
  if (visionZone) beacon.userData.hideFromVirtualCamera = true;
  group.add(beacon);
  if (visionZone) {
    // A solid, vertical camera marker gives the pixel detector an unambiguous
    // zone signature from every approach direction. Floor rings remain visual
    // guidance only and are intentionally not used as the recognition target.
    const visionSign = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.17, 0.68, 12),
      new THREE.MeshBasicMaterial({ color, toneMapped: false })
    );
    visionSign.position.y = 0.42;
    visionSign.userData.kind = "vision-zone-sign";
    visionSign.userData.objectCategory = activeMission.goalCategory;
    group.add(visionSign);
  }
  const glow = new THREE.PointLight(
    visionZone ? "#ffffff" : boundaryColor,
    visionZone ? 0.2 : mazeGoal ? 0.72 : 0.5,
    mazeGoal ? 4.2 : 3.2,
    2
  );
  glow.position.y = mazeGoal ? 0.72 : 0.55;
  if (visionZone) glow.userData.hideFromVirtualCamera = true;
  group.add(glow);
  group.position.set(pos[0], activeMission.environment === "guangyang" ? 0.09 : 0, pos[1]);
  group.userData.kind = "goal";
  group.userData.objectCategory = activeMission.goalCategory || "终点";
  group.userData.goalPulse = { ring: pulseRing, beacon, glow };
  goalPulseEffects.push(group.userData.goalPulse);
  enableObjectShadows(group);
  pulseRing.castShadow = false;
  boundaryRing.castShadow = false;
  beacon.castShadow = false;
  scene.add(group);
  markerMeshes.push(group);
  const label = createTextLabel(goalLabel, pos[0], pos[1] - 0.62, 0.12);
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
    // The front strip is a short fold from the top, not a full-height divider.
    // This keeps the colored box face one connected pixel region for the
    // frozen detector while retaining visible packing-tape detail.
    frontTapeGeometry: new THREE.BoxGeometry(0.085, 0.12, 0.014),
    labelGeometry: new THREE.BoxGeometry(0.17, 0.105, 0.009),
    barcodeGeometry: new THREE.BoxGeometry(0.011, 0.062, 0.006),
    ballGeometry: new THREE.SphereGeometry(0.22, 28, 20),
    bodyMaterial: new THREE.MeshStandardMaterial({ color: "#c78345", roughness: 0.82, metalness: 0.02 }),
    targetBoxMaterial: new THREE.MeshStandardMaterial({ color: "#ef4444", emissive: "#7f1d1d", emissiveIntensity: 0.14, roughness: 0.72, metalness: 0.02 }),
    distractorBoxMaterial: new THREE.MeshStandardMaterial({ color: "#3b82f6", emissive: "#1e3a8a", emissiveIntensity: 0.16, roughness: 0.72, metalness: 0.02 }),
    tapeMaterial: new THREE.MeshStandardMaterial({ color: "#e9bd72", roughness: 0.62 }),
    labelMaterial: new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.7 }),
    inkMaterial: new THREE.MeshBasicMaterial({ color: "#334155" }),
    edgeMaterial: new THREE.LineBasicMaterial({ color: "#704326", transparent: true, opacity: 0.72 }),
    ballMaterial: new THREE.MeshStandardMaterial({ color: "#ef4444", emissive: "#7f1d1d", emissiveIntensity: 0.18, roughness: 0.4 }),
    distractorBallMaterial: new THREE.MeshStandardMaterial({ color: "#3b82f6", emissive: "#1e3a8a", emissiveIntensity: 0.2, roughness: 0.4 })
  };
  return packageAssetCache;
}

function createPackageModel(record, stackLevel, index) {
  const assets = getPackageAssets();
  const group = new THREE.Group();
  const category = packageCategory(record);
  if (activeMission.packageVisual === "ball") {
    const material = category === "distractor" ? assets.distractorBallMaterial : assets.ballMaterial;
    const ball = new THREE.Mesh(assets.ballGeometry, material);
    ball.castShadow = true;
    ball.receiveShadow = true;
    group.add(ball);
  } else {
    const bodyMaterial = activeMission.environment === "guangyang"
      ? category === "distractor" ? assets.distractorBoxMaterial : assets.targetBoxMaterial
      : assets.bodyMaterial;
    const body = new THREE.Mesh(assets.bodyGeometry, bodyMaterial);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    group.add(new THREE.LineSegments(assets.edgeGeometry, assets.edgeMaterial));
    const topTape = new THREE.Mesh(assets.topTapeGeometry, assets.tapeMaterial);
    topTape.position.y = PACKAGE_HEIGHT / 2 + 0.006;
    group.add(topTape);
    const frontTape = new THREE.Mesh(assets.frontTapeGeometry, assets.tapeMaterial);
    frontTape.position.y = PACKAGE_HEIGHT / 2 - 0.06;
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
  }
  if (activeMission.environment === "guangyang" && ["target", "distractor"].includes(category)
    && !isGuangyangAiAutonomyMission()) {
    attachObjectNameLabel(group, trainingVisionCategoryLabel(category), 0.72);
  }
  group.position.set(record.x, currentPackageBaseY() + stackLevel * PACKAGE_STACK_STEP, record.z);
  group.userData.kind = "package";
  group.userData.packageId = record.id;
  group.userData.stackLevel = stackLevel;
  group.userData.stackKey = packageStackKey(record.x, record.z);
  group.userData.packageIndex = index;
  group.userData.packageVisual = activeMission.packageVisual === "ball" ? "ball" : "box";
  group.userData.objectCategory = category;
  group.userData.collisionRadius = Number(record.radius) > 0
    ? Number(record.radius)
    : Number(activeMission.packageRadius) > 0 ? Number(activeMission.packageRadius) : PACKAGE_RADIUS;
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
  invalidateDeterministicSimulator();
  heldPackageId = null;
  heldPackageMesh = null;
  lastMoveBlocked = false;
  blockedMoveCount = 0;
  if (robotArm) robotArm.rotation.x = 0;
  if (robotClaw) robotClaw.scale.x = 1;
  const [x, z, heading] = activeMission.start || [-3, -3, 0];
  robotPose = { x, z, heading };
  syncRobot(undefined, { forceTelemetry: true });
  resetTrajectory();
}

function syncRobot(measuredDistance = undefined, { forceTelemetry = false, skipCompetitionTick = false } = {}) {
  robotGroup.position.set(robotPose.x, activeMission.environment === "guangyang" ? 0.105 : 0, robotPose.z);
  robotGroup.rotation.y = robotPose.heading;
  markSceneShadowDirty();
  updateRobotTelemetry(measuredDistance, forceTelemetry);
  if (!skipCompetitionTick) competitionTick(forceTelemetry);
}

function updateRobotTelemetry(measuredDistance = undefined, force = false, { allowMissionComplete = true } = {}) {
  const now = performance.now();
  if (!force && now - lastRobotTelemetryAt < ROBOT_TELEMETRY_INTERVAL_MS) return;
  lastRobotTelemetryAt = now;
  const real = targetSelect?.value === "real";
  const resolvedDistance = real ? null : measuredDistance ?? frontDistance();
  updateDistance(resolvedDistance);
  updateRobotState(resolvedDistance);
  if (real) return;
  if (missionAttempt?.spec.type !== "delivery") evaluateMissionProgress({ allowComplete: allowMissionComplete });
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
  const pathY = activeMission.environment === "guangyang" ? 0.132 : 0.052;
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
    positions[offset + 1] = pathY;
    positions[offset + 2] = prev.z + sideZ;
    positions[offset + 3] = prev.x - sideX;
    positions[offset + 4] = pathY;
    positions[offset + 5] = prev.z - sideZ;
    positions[offset + 6] = next.x + sideX;
    positions[offset + 7] = pathY;
    positions[offset + 8] = next.z + sideZ;
    positions[offset + 9] = next.x - sideX;
    positions[offset + 10] = pathY;
    positions[offset + 11] = next.z - sideZ;
    segmentCount++;
  }
  trajectoryPositionAttribute.needsUpdate = true;
  trajectoryLine.geometry.setDrawRange(0, segmentCount * 6);
  trajectoryLine.visible = segmentCount > 0;
  if (trajectoryHead) {
    const last = trajectoryPoints[trajectoryPoints.length - 1];
    trajectoryHead.position.set(last.x, activeMission.environment === "guangyang" ? 0.138 : 0.058, last.z);
    trajectoryHead.visible = segmentCount > 0;
  }
}

function directionVector() {
  directionVectorScratch.x = -Math.sin(robotPose.heading);
  directionVectorScratch.z = -Math.cos(robotPose.heading);
  return directionVectorScratch;
}

function circleOverlapsCircle(x, z, radius, otherX, otherZ, otherRadius) {
  if (![x, z, radius, otherX, otherZ, otherRadius].every(Number.isFinite) || radius < 0 || otherRadius < 0) return true;
  const dx = x - otherX;
  const dz = z - otherZ;
  const combined = radius + otherRadius;
  return dx * dx + dz * dz < combined * combined;
}

function rayCircleEntry(originX, originZ, dirX, dirZ, centerX, centerZ, radius) {
  if (![originX, originZ, dirX, dirZ, centerX, centerZ, radius].every(Number.isFinite) || radius < 0) return 0;
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
  if (![originX, originZ, dirX, dirZ, minX, maxX, minZ, maxZ].every(Number.isFinite)) return 0;
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
  if (![originX, originZ, dirX, dirZ, rectX, rectZ, rectW, rectH, radius].every(Number.isFinite) || radius < 0) return 0;
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
  const bounds = currentPlayableBounds();
  if (![originX, originZ, dirX, dirZ, bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite)
    || outsidePlayableBounds(originX, originZ)) return 0;
  const edgeX = dirX > PHYSICS_EPSILON
    ? (bounds.maxX - originX) / dirX
    : dirX < -PHYSICS_EPSILON ? (bounds.minX - originX) / dirX : Infinity;
  const edgeZ = dirZ > PHYSICS_EPSILON
    ? (bounds.maxZ - originZ) / dirZ
    : dirZ < -PHYSICS_EPSILON ? (bounds.minZ - originZ) / dirZ : Infinity;
  return Math.max(0, Math.min(edgeX, edgeZ));
}

function colliderCoordinate(value) {
  const number = Math.abs(Number(value)) < 0.0005 ? 0 : Number(value);
  return number.toFixed(3);
}

function packageColliderStackKey(x, z) {
  const roundCoordinate = value => Math.round((Number(value) || 0) * 1000) / 1000;
  return `${roundCoordinate(x)},${roundCoordinate(z)}`;
}

function rebuildRobotCollisionShapes() {
  const usedIds = new Map();
  const uniqueId = baseId => {
    const count = usedIds.get(baseId) || 0;
    usedIds.set(baseId, count + 1);
    return count ? `${baseId}:${count + 1}` : baseId;
  };
  const shapes = obstacleMeshes.map(mesh => {
    const interactionObjectId = String(mesh.userData.interactionObjectId || "").trim();
    return {
      id: uniqueId(interactionObjectId
        ? `object:${interactionObjectId}`
        : `obstacle:${colliderCoordinate(mesh.position.x)}:${colliderCoordinate(mesh.position.z)}`),
      source: interactionObjectId ? "package" : "obstacle",
      type: "circle",
      x: mesh.position.x,
      z: mesh.position.z,
      radius: Number(mesh.userData.collisionRadius) > 0 ? Number(mesh.userData.collisionRadius) : BLOCK_RADIUS
    };
  });
  const packageStacks = new Set();
  packageMeshes.forEach(mesh => {
    if (!mesh.visible || mesh === heldPackageMesh) return;
    const key = mesh.userData.stackKey || packageStackKey(mesh.position.x, mesh.position.z);
    if (packageStacks.has(key)) return;
    packageStacks.add(key);
    shapes.push({
      id: uniqueId(`package-stack:${packageColliderStackKey(mesh.position.x, mesh.position.z)}`),
      source: "package",
      type: "circle",
      x: mesh.position.x,
      z: mesh.position.z,
      radius: Number(mesh.userData.collisionRadius) > 0 ? Number(mesh.userData.collisionRadius) : PACKAGE_RADIUS
    });
  });
  getActiveWallColliders().forEach(rect => shapes.push({
    id: uniqueId([
      "wall",
      colliderCoordinate(rect.x),
      colliderCoordinate(rect.z),
      colliderCoordinate(Math.abs(rect.w)),
      colliderCoordinate(Math.abs(rect.h))
    ].join(":")),
    source: "wall",
    type: "rect",
    rect
  }));
  robotCollisionShapes = shapes;
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

function robotClearanceAlongRay(originX, originZ, dirX, dirZ) {
  if (![originX, originZ, dirX, dirZ].every(Number.isFinite)) return 0;
  const length = Math.hypot(dirX, dirZ);
  if (length <= PHYSICS_EPSILON) return Infinity;
  const normalizedX = dirX / length;
  const normalizedZ = dirZ / length;
  let nearest = playableBoundaryRayDistance(originX, originZ, normalizedX, normalizedZ);
  for (const shape of robotCollisionShapes) {
    const candidate = collisionShapeRayDistance(shape, originX, originZ, normalizedX, normalizedZ);
    nearest = Number.isNaN(candidate) ? 0 : Math.min(nearest, candidate);
  }
  return Math.max(0, nearest);
}

function frontDistance() {
  const dir = directionVector();
  return robotClearanceAlongRay(robotPose.x, robotPose.z, dir.x, dir.z);
}

function wallForwardDistance(dir) {
  const length = Math.hypot(Number(dir?.x), Number(dir?.z));
  if (!Number.isFinite(length) || length <= PHYSICS_EPSILON) return Infinity;
  const dirX = dir.x / length;
  const dirZ = dir.z / length;
  return getActiveWallColliders().reduce((nearest, rect) => Math.min(
    nearest,
    rayRoundedRectEntry(robotPose.x, robotPose.z, dirX, dirZ, rect, ROBOT_RADIUS)
  ), Infinity);
}

function mapEdgeForwardDistance(dir) {
  return playableBoundaryRayDistance(robotPose.x, robotPose.z, Number(dir?.x), Number(dir?.z));
}

function outsidePlayableBounds(x, z) {
  const bounds = currentPlayableBounds();
  return !Number.isFinite(x) || !Number.isFinite(z)
    || !Object.values(bounds).every(Number.isFinite)
    || x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ;
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

function circleHitsRect(x, z, radius, rect) {
  const rectX = Number(rect?.x);
  const rectZ = Number(rect?.z);
  const rectW = Number(rect?.w);
  const rectH = Number(rect?.h);
  if (![x, z, radius, rectX, rectZ, rectW, rectH].every(Number.isFinite) || radius < 0) return true;
  const halfW = Math.abs(rectW) / 2;
  const halfH = Math.abs(rectH) / 2;
  const closestX = Math.max(rectX - halfW, Math.min(x, rectX + halfW));
  const closestZ = Math.max(rectZ - halfH, Math.min(z, rectZ + halfH));
  const dx = x - closestX;
  const dz = z - closestZ;
  return dx * dx + dz * dz < radius * radius;
}

function formatSensorDistance(distance) {
  const centimeters = Math.max(0, worldUnitsToCm(distance));
  return !Number.isFinite(centimeters) || centimeters > SENSOR_DISPLAY_MAX_CM
    ? `>${SENSOR_DISPLAY_MAX_CM} cm`
    : `${Math.round(centimeters)} cm`;
}

function setTextIfChanged(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function updateDistance(measuredDistance = null) {
  if (targetSelect?.value === "real") {
    setTextIfChanged(distanceText, "无传感器");
    return;
  }
  const distance = measuredDistance ?? frontDistance();
  setTextIfChanged(distanceText, formatSensorDistance(distance));
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
  setTextIfChanged(poseText,
    `${Math.round(worldUnitsToCm(robotPose.x))}, ${Math.round(worldUnitsToCm(robotPose.z))} cm`);
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

function attachPackageToRobot(packageId = null) {
  const requestedMesh = packageId == null
    ? null
    : packageMeshes.find(mesh => mesh.userData.packageId === packageId && mesh !== heldPackageMesh);
  const reach = requestedMesh
    ? { reachable: true, mesh: requestedMesh }
    : packageId == null
      ? packageReachInfo()
      : { reachable: false, mesh: null };
  if (!reach.reachable || !reach.mesh) return false;
  const packageMesh = reach.mesh;
  scene.remove(packageMesh);
  robotClaw.add(packageMesh);
  packageMesh.position.set(0, 0, -0.25);
  packageMesh.rotation.set(0, 0, 0);
  packageMesh.scale.set(0.78 / Math.max(0.1, robotClaw.scale.x), 0.78, 0.78);
  heldPackageId = packageMesh.userData.packageId;
  heldPackageMesh = packageMesh;
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

function releasePackageFromRobot(interactionResult = null) {
  if (!isHoldingPackage()) return false;
  const packageMesh = heldPackageMesh;
  const packageId = heldPackageId;
  if (interactionResult?.packageId && interactionResult.packageId !== packageId) return false;
  const worldPos = new THREE.Vector3();
  packageMesh.getWorldPosition(worldPos);
  if (packageMesh.parent) packageMesh.parent.remove(packageMesh);
  scene.add(packageMesh);
  const packageBounds = currentPlayableBounds(PACKAGE_RADIUS);
  const resultPosition = interactionResult?.position;
  const resultX = Number(Array.isArray(resultPosition) ? resultPosition[0] : resultPosition?.x);
  const resultZ = Number(Array.isArray(resultPosition) ? resultPosition[1] : resultPosition?.z);
  const hasCanonicalPosition = Number.isFinite(resultX) && Number.isFinite(resultZ);
  const boundedX = Math.max(packageBounds.minX, Math.min(packageBounds.maxX, hasCanonicalPosition ? resultX : worldPos.x));
  const boundedZ = Math.max(packageBounds.minZ, Math.min(packageBounds.maxZ, hasCanonicalPosition ? resultZ : worldPos.z));
  const nearbyStack = hasCanonicalPosition ? null : findNearbyPackageStack(boundedX, boundedZ, packageId);
  const dropX = nearbyStack ? nearbyStack.x : boundedX;
  const dropZ = nearbyStack ? nearbyStack.z : boundedZ;
  const packages = ensureMissionPackages();
  const recordIndex = packages.findIndex(record => record.id === packageId);
  const record = recordIndex >= 0 ? packages.splice(recordIndex, 1)[0] : { id: packageId, x: dropX, z: dropZ };
  record.x = dropX;
  record.z = dropZ;
  const canonicalStackLevel = Number(interactionResult?.stackLevel);
  const stackLevel = Number.isSafeInteger(canonicalStackLevel) && canonicalStackLevel >= 0
    ? canonicalStackLevel
    : packages.filter(item => packageStackKey(item.x, item.z) === packageStackKey(dropX, dropZ)).length;
  packages.push(record);
  packageMesh.position.set(dropX, currentPackageBaseY() + stackLevel * PACKAGE_STACK_STEP, dropZ);
  packageMesh.rotation.set(0, 0, 0);
  packageMesh.scale.setScalar(1);
  packageMesh.userData.stackLevel = stackLevel;
  packageMesh.userData.stackKey = packageStackKey(dropX, dropZ);
  packageMesh.userData.packageIndex = packages.length - 1;
  heldPackageId = null;
  heldPackageMesh = null;
  rebuildRobotCollisionShapes();
  markSceneShadowDirty();
  return {
    id: packageId,
    position: [dropX, dropZ],
    stackLevel,
    snapped: interactionResult ? Boolean(interactionResult.snapped) : Boolean(nearbyStack)
  };
}

async function animateGripper(closing) {
  if (!robotArm || !robotClaw) return;
  if (closing) {
    await animateArmTo(-0.32, 260);
    await animateClawTo(0.72, 220);
    return;
  }
  await animateClawTo(1, 180);
  await animateArmTo(0, 240);
}

async function animateArmTo(targetRotation, duration = 260) {
  if (!robotArm) return;
  if (interactionAnimationPlan) {
    queueInteractionAnimation("arm", targetRotation, duration);
    return;
  }
  const startRotation = robotArm.rotation.x;
  let elapsed = 0;
  let last = performance.now();
  while (!stopRequested && elapsed < duration) {
    if (pauseRequested) {
      await waitWhilePaused();
      last = performance.now();
      continue;
    }
    const now = performance.now();
    elapsed += Math.min(50, now - last);
    last = now;
    const t = Math.min(1, elapsed / duration);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    robotArm.rotation.x = startRotation + (targetRotation - startRotation) * eased;
    markSceneShadowDirty();
    await sleep(16);
  }
  if (stopRequested) return;
  robotArm.rotation.x = targetRotation;
  markSceneShadowDirty();
}

async function animateClawTo(targetScale, duration = 180) {
  if (!robotClaw) return;
  if (interactionAnimationPlan) {
    queueInteractionAnimation("claw", targetScale, duration);
    return;
  }
  const startScale = robotClaw.scale.x;
  let elapsed = 0;
  let last = performance.now();
  while (!stopRequested && elapsed < duration) {
    if (pauseRequested) {
      await waitWhilePaused();
      last = performance.now();
      continue;
    }
    const now = performance.now();
    elapsed += Math.min(50, now - last);
    last = now;
    const t = Math.min(1, elapsed / duration);
    const eased = 1 - Math.pow(1 - t, 2);
    robotClaw.scale.x = startScale + (targetScale - startScale) * eased;
    markSceneShadowDirty();
    await sleep(16);
  }
  if (stopRequested) return;
  robotClaw.scale.x = targetScale;
  markSceneShadowDirty();
}

async function liftArmToCarryPosition() {
  await animateArmTo(0, 280);
}

function hasCompetitionInteractionApi() {
  return competitionSession?.status === "running"
    && typeof competitionSession.addInteractionInput === "function";
}

function addCompetitionInteractionInput(kind) {
  if (!hasCompetitionInteractionApi()) return null;
  const inputType = kind === "grab" ? "package_grab" : kind === "release" ? "package_release" : kind;
  return competitionSession.addInteractionInput(inputType);
}

function settleGripperVisual(holding = isHoldingPackage()) {
  if (robotArm) robotArm.rotation.x = 0;
  if (robotClaw) robotClaw.scale.x = holding ? 0.72 : 1;
  if (holding && heldPackageMesh) {
    heldPackageMesh.scale.set(0.78 / 0.72, 0.78, 0.78);
  }
  markSceneShadowDirty();
}

async function runInteractionAnimation(animation, durationMs) {
  if (robotBackendMode || competitionSession?.simulationDefinition) {
    if (interactionAnimationPlan) throw new Error("Interaction animations cannot overlap");
    const plan = { segments: [], cursorMs: 0,
      arm: robotArm?.rotation.x ?? 0, claw: robotClaw?.scale.x ?? 1 };
    interactionAnimationPlan = plan;
    try {
      // Existing animation callbacks describe their stages without advancing
      // wall time. Exactly the original wait command advances the simulator.
      await animation();
    } finally {
      interactionAnimationPlan = null;
    }
    const simulator = ensureDeterministicSimulator();
    const startTick = simulator.tick;
    await runDeterministicCommand({ kind: "wait", durationMs }, frame => {
      applyInteractionAnimation(plan, (frame.state.tick - startTick) * simulator.config.stepMs);
    });
    return;
  }
  await Promise.all([
    animation(),
    runDeterministicCommand({ kind: "wait", durationMs })
  ]);
}

function queueInteractionAnimation(kind, target, durationMs) {
  const plan = interactionAnimationPlan;
  plan.segments.push({ kind, start: plan[kind], target, startMs: plan.cursorMs, durationMs });
  plan[kind] = target;
  plan.cursorMs += durationMs;
}

function applyInteractionAnimation(plan, elapsedMs) {
  for (const segment of plan.segments) {
    if (elapsedMs < segment.startMs) continue;
    const t = Math.min(1, Math.max(0, (elapsedMs - segment.startMs) / segment.durationMs));
    const eased = segment.kind === "arm"
      ? t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      : 1 - Math.pow(1 - t, 2);
    const value = segment.start + (segment.target - segment.start) * eased;
    if (segment.kind === "arm" && robotArm) robotArm.rotation.x = value;
    if (segment.kind === "claw" && robotClaw) robotClaw.scale.x = value;
  }
  markSceneShadowDirty();
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

function normalizeDriveSpeed(speedPercent = 50) {
  const value = Number(speedPercent);
  if (!Number.isFinite(value)) throw new TypeError("道路控制速度必须填写 10 到 100 之间的数字");
  if (value < 10 || value > 100) throw new RangeError("速度必须在 10 到 100 之间");
  return value;
}

function normalizeDriveDistanceCm(distanceCm) {
  const value = Number(distanceCm);
  if (!Number.isFinite(value)) throw new TypeError("行驶距离必须填写数字，例如 robot.forward(50)");
  if (value < 0.1 || value > 500) throw new RangeError("行驶距离必须在 0.1 到 500 厘米之间");
  return value;
}

function driveDistancePlan(distanceCm) {
  const requestedDistanceCm = normalizeDriveDistanceCm(distanceCm);
  // Competition missions keep their frozen rules below `competition.config`.
  // Reading `competition.rules` silently fell back to 1 unit/metre, so a
  // `robot.forward(50)` request travelled only 0.5 world units on the
  // Guangyang map (6.25 cm at 8 units/metre). Training missions expose the
  // same frozen scene as `guangyangSceneConfig`, so keep that path aligned too.
  const configuredUnitsPerMeter = Number(
    activeMission?.competition?.config?.rules?.unitsPerMeter
      ?? activeMission?.guangyangSceneConfig?.rules?.unitsPerMeter
  );
  const unitsPerMeter = configuredUnitsPerMeter > 0
    ? configuredUnitsPerMeter
    : GUANGYANG_WORLD_UNITS_PER_METER;
  const stepMs = 20;
  const maximumSpeed = 2.5;
  const nominalSpeed = maximumSpeed * 0.5;
  const worldDistance = requestedDistanceCm * unitsPerMeter / 100;
  const ticks = Math.max(1, Math.ceil(worldDistance / (nominalSpeed * stepMs / 1000)));
  const durationMs = ticks * stepMs;
  const speed = worldDistance / (durationMs / 1000);
  return { requestedDistanceCm, durationMs, speed, speedPercent: speed / maximumSpeed * 100 };
}

async function runDeterministicCommand(command, onFrame = null) {
  const simulatorCore = ensureDeterministicSimulator();
  const world = simulationWorldDefinition({ includePackages: true });
  simulatorCore.setWorld(world);
  const started = simulatorCore.startCommand(command);
  if (competitionSession?.status === "running") {
    competitionSession.addSimulationInput(started.command, {
      tick: started.startState.tick,
      startState: started.startState,
      source: "python"
    });
  }
  let nextFrameAt = robotBackendMode ? 0 : performance.now();
  let lastFrame = null;
  while (!stopRequested && simulatorCore.hasActiveCommand()) {
    if (pauseRequested) {
      await waitWhilePaused();
      nextFrameAt = robotBackendMode ? 0 : performance.now();
      continue;
    }
    lastFrame = simulatorCore.step();
    const state = lastFrame.state;
    if (realtimeRun && Number.isFinite(lastFrame.distance)) {
      realtimeRun.navigationDistance += Math.abs(lastFrame.distance);
    }
    robotPose.x = state.pose.x;
    robotPose.z = state.pose.z;
    robotPose.heading = state.pose.heading;
    robotLinearSpeed = lastFrame.linearSpeed;
    robotSteering = lastFrame.angularSpeed;
    if (typeof onFrame === "function") onFrame(lastFrame);
    syncRobot(undefined, { forceTelemetry: lastFrame.completed });
    if (!simulatorCore.hasActiveCommand() || stopRequested) break;
    if (!robotBackendMode) {
      nextFrameAt += simulatorCore.config.stepMs;
      const delay = nextFrameAt - performance.now();
      if (delay > 0) await sleep(delay);
      else await sleep(0);
    }
  }
  const result = simulatorCore.hasActiveCommand()
    ? simulatorCore.cancelCommand()
    : simulatorCore.lastCommandResult;
  robotLinearSpeed = 0;
  robotSteering = 0;
  competitionTick(true);
  updateRobotTelemetry(undefined, true);
  return { lastFrame, result, stopped: stopRequested };
}

async function moveRobot(sign, seconds, requestedSpeed = 50, distancePlan = null) {
  await waitWhilePaused();
  if (stopRequested) return;
  actionCount++;
  let moved = false;
  let collisionObserved = false;
  // Distance commands have already been quantized to the simulator's 20 ms
  // tick. The 80 ms minimum belongs only to the legacy timed-drive path;
  // applying it here made robot.forward(0.1) overshoot to about 0.4 cm.
  const totalMs = distancePlan
    ? Number(distancePlan.durationMs)
    : Math.max(MIN_CONTROL_SECONDS, Number(seconds) || MIN_CONTROL_SECONDS) * 1000;
  const speedPercent = distancePlan ? distancePlan.speedPercent : normalizeDriveSpeed(requestedSpeed);
  const action = sign > 0 ? "前进" : "后退";
  addLog(distancePlan
    ? `${action} ${Math.round(distancePlan.requestedDistanceCm * 10) / 10} 厘米，方向 ${headingName()}。`
    : `${action} ${Math.round(totalMs / 10) / 100} 秒，速度 ${Math.round(speedPercent)}%，方向 ${headingName()}。`);
  const execution = await runDeterministicCommand({
    kind: "drive",
    direction: sign,
    durationMs: totalMs,
    ...(distancePlan ? { speed: distancePlan.speed } : { speedPercent })
  }, frame => {
    if (frame.distance > PHYSICS_EPSILON) {
      spinDriveWheels(frame.distance * sign);
      moved = true;
      blockedMoveCount = 0;
      lastMoveBlocked = false;
      addTrajectoryPoint(frame.state.pose.x, frame.state.pose.z);
    }
    if (frame.blocked && !collisionObserved) {
      collisionObserved = true;
      if (activeMission.objectTraining?.type === "obstacle-avoidance" && missionAttempt) {
        missionAttempt.trainingCollisionCount = Number(missionAttempt.trainingCollisionCount || 0) + 1;
        renderMissionProgress();
      }
      const collisions = frame.collisions || frame.state?.collisions || [];
      const collision = frame.collision || collisions[collisions.length - 1];
      recordCompetitionViolation("collision", {
        message: "车辆与障碍物发生碰撞",
        colliderId: collision?.colliderId || "unknown",
        tick: collision?.tick ?? frame.tick,
        x: frame.x,
        z: frame.z
      }, frame.elapsedMs);
    }
  });
  if (execution.result?.blocked) {
    if (!missionAttempt?.completed && competitionSession?.status !== "completed") {
      setStatus("前方受阻，等待下一条代码");
    }
    blockedMoveCount++;
    lastMoveBlocked = true;
    addLog(`${action} 被挡住：当前动作结束，程序继续执行下一条代码。`);
  }
  if (!moved && blockedMoveCount >= 3) {
    stopRequested = true;
    setStatus("巡逻受阻，已暂停");
    addLog("连续 3 次前进都被挡住，已暂停。请在持续巡逻里加入“如果前方有障碍物 -> 左转90°/右转90°”。");
  }
}

async function moveRobotDistance(sign, distanceCm) {
  const plan = driveDistancePlan(distanceCm);
  return moveRobot(sign, plan.durationMs / 1000, plan.speedPercent, plan);
}

async function turnRobot(dir, seconds) {
  await waitWhilePaused();
  if (stopRequested) return;
  actionCount++;
  blockedMoveCount = 0;
  lastMoveBlocked = false;
  const sign = dir === "left" ? 1 : -1;
  const totalMs = Math.max(MIN_CONTROL_SECONDS, Number(seconds) || MIN_CONTROL_SECONDS) * 1000;
  addLog(`${dir === "left" ? "左转" : "右转"} ${Math.round(totalMs / 10) / 100} 秒，用来改变朝向。`);
  await runDeterministicCommand({ kind: "turn", direction: sign, durationMs: totalMs }, frame => {
    spinTurnWheels(sign, Math.abs(frame.headingDelta) * 2.4);
  });
  addLog(`转向后朝向 ${headingName()}。`);
}

function normalizeTurnDegrees(degrees) {
  if (typeof degrees !== "number" || !Number.isFinite(degrees)) {
    throw new TypeError("转向角度必须填写数字，例如 robot.left_angle(45)");
  }
  if (degrees < 1 || degrees > 360) {
    throw new RangeError("转向角度必须是 1 到 360 度之间的有限数字");
  }
  return degrees;
}

function turnAngleDurationSeconds(degrees) {
  const angle = normalizeTurnDegrees(degrees);
  const physicalMinimum = THREE.MathUtils.degToRad(angle) / 2.8;
  return Math.ceil(Math.max(0.26, physicalMinimum) / 0.02) * 0.02;
}

async function turnRobotAngle(dir, degrees) {
  const requestedDegrees = normalizeTurnDegrees(degrees);
  await waitWhilePaused();
  if (stopRequested) return;
  actionCount++;
  blockedMoveCount = 0;
  lastMoveBlocked = false;
  const sign = dir === "left" ? 1 : -1;
  const angle = THREE.MathUtils.degToRad(requestedDegrees);
  const totalMs = turnAngleDurationSeconds(requestedDegrees) * 1000;
  addLog(`${dir === "left" ? "左转" : "右转"} ${Math.round(THREE.MathUtils.radToDeg(angle))}°，精确改变朝向。`);
  await runDeterministicCommand({
    kind: "turn_angle",
    direction: sign,
    angleDegrees: requestedDegrees,
    durationMs: totalMs
  }, frame => {
    spinTurnWheels(sign, Math.abs(frame.headingDelta) * 2.4);
  });
  if (stopRequested) return;
  addLog(`转向后朝向 ${headingName()}。`);
}

function classifyCompetitionReleaseResult(interactionResult, holding) {
  if (!interactionResult) return "local";
  if (interactionResult.accepted) return "accepted";
  if (!holding) return "empty";
  return interactionResult.reason === "blocked" ? "blocked-held" : "rejected-held";
}

function readNavigationSensor(method) {
  if (!realtimeRun) throw new Error("导航传感器只可在 Python 程序运行期间读取。");
  const sceneConfig = currentGuangyangSceneConfig();
  if ((method === "road_state" || method === "map_graph" || method === "mission" || method === "task_state" || method === "release_preview")
    && !Array.isArray(sceneConfig?.rules?.roads)) {
    throw new Error("当前场景没有道路传感数据，请切换到广阳岛地图。");
  }
  if (competitionSession?.status === "running"
    && typeof competitionSession.addNavigationQuery === "function") {
    return competitionSession.addNavigationQuery(method);
  }
  if (method === "mission" || method === "task_state" || method === "release_preview") {
    throw new Error("任务语义与任务进度只可在正式广阳岛场次中读取。");
  }
  const core = globalThis.CompetitionCore;
  if (!core?.projectNavigationQuery || !core?.NAVIGATION_DEFINITION) {
    throw new Error("导航传感器尚未就绪，请刷新页面后重试。");
  }
  const currentTick = deterministicSimulator?.tick ?? realtimeRun.navigationStartTick ?? 0;
  return core.projectNavigationQuery(method, {
    pose: robotPose,
    initialPose: realtimeRun.navigationOrigin,
    distance: realtimeRun.navigationDistance,
    tick: Math.max(0, currentTick - realtimeRun.navigationStartTick),
    rules: sceneConfig?.rules || {},
    navigationDefinition: core.NAVIGATION_DEFINITION,
    world: simulationWorldDefinition({ includePackages: true }),
    vehicleRadius: ROBOT_RADIUS
  });
}

function navigationControlReasonLabel(reason) {
  return ({
    max_distance: "已到达本次设定距离",
    junction: "已在前方路口停车",
    road_end: "已在道路端点停车",
    front_clearance: "前方净空不足，已安全停车",
    off_road: "当前位置不在可循道路上",
    wrong_way: "当前朝向不符合单行道路方向",
    entered_road: "已进入指定道路",
    not_at_junction: "当前位置不在路口附近",
    invalid_exit: "指定道路不是当前合法出口",
    collision: "发生碰撞，动作已停止",
    safety_limit: "达到局部控制安全上限",
    time_limit: "达到当前运行时间上限"
  })[String(reason || "")] || "局部道路动作已停止";
}

function navigationControlFramePose(frame) {
  const source = frame?.state?.pose || frame?.pose || frame;
  const x = Number(source?.x);
  const z = Number(source?.z);
  const heading = Number(source?.heading);
  return [x, z, heading].every(Number.isFinite) ? { x, z, heading } : null;
}

function renderNavigationControlFrame(frame) {
  const pose = navigationControlFramePose(frame);
  if (!pose) return;
  robotPose.x = pose.x;
  robotPose.z = pose.z;
  robotPose.heading = pose.heading;
  robotLinearSpeed = Number(frame?.linearSpeed) || 0;
  robotSteering = Number(frame?.angularSpeed) || 0;
  const distance = Number(frame?.distance) || 0;
  const headingDelta = Number(frame?.headingDelta) || 0;
  if (Math.abs(distance) > 0) {
    spinDriveWheels(distance);
    addTrajectoryPoint(pose.x, pose.z);
  }
  if (Math.abs(headingDelta) > 0) spinTurnWheels(Math.sign(headingDelta) || 1, Math.abs(headingDelta) * 2.4);
  robotGroup.position.set(pose.x, activeMission.environment === "guangyang" ? 0.105 : 0, pose.z);
  robotGroup.rotation.y = pose.heading;
  markSceneShadowDirty();
  updateRobotTelemetry(undefined, Boolean(frame?.completed), { allowMissionComplete: false });
}

function navigationPlaybackContextIsCurrent(context) {
  return Boolean(context
    && context.runToken === runToken
    && context.simulator === deterministicSimulator
    && context.missionBuildGeneration === missionBuildGeneration);
}

async function playNavigationControlFrames(frames, simulatorCore, context) {
  const finalPose = simulatorCore.compactSnapshot().pose;
  const stepMs = simulatorCore.config.stepMs;
  navigationVisualPlayback = context;
  const pendingRunId = pendingPythonRun?.id ?? null;
  if (pendingPythonRun) clearTimeout(pendingPythonRun.timer);
  let nextFrameAt = robotBackendMode ? 0 : performance.now();
  let localCollisionRecorded = false;
  let publishedFinalPose = false;
  try {
    for (const frame of frames) {
      if (!navigationPlaybackContextIsCurrent(context) || stopRequested) break;
      if (pauseRequested) {
        await waitWhilePaused();
        nextFrameAt = robotBackendMode ? 0 : performance.now();
        if (!navigationPlaybackContextIsCurrent(context) || stopRequested) break;
      }
      renderNavigationControlFrame(frame);
      if (!context.formalCompetition && frame?.collision && !localCollisionRecorded) {
        localCollisionRecorded = true;
        if (activeMission.objectTraining?.type === "obstacle-avoidance" && missionAttempt) {
          missionAttempt.trainingCollisionCount = Number(missionAttempt.trainingCollisionCount || 0) + 1;
          renderMissionProgress();
        }
        addLog("道路控制检测到碰撞，本次局部动作已停止。");
      }
      if (!robotBackendMode) {
        nextFrameAt += stepMs;
        const delay = nextFrameAt - performance.now();
        if (delay > 0) await sleep(delay);
        else await sleep(0);
      }
    }
  } finally {
    const publishFinalPose = navigationPlaybackContextIsCurrent(context);
    if (navigationVisualPlayback === context) navigationVisualPlayback = null;
    if (publishFinalPose) {
      robotPose.x = finalPose.x;
      robotPose.z = finalPose.z;
      robotPose.heading = finalPose.heading;
      robotLinearSpeed = 0;
      robotSteering = 0;
      syncRobot(undefined, { forceTelemetry: true, skipCompetitionTick: context.formalCompetition });
      publishedFinalPose = true;
    }
    if (pendingPythonRun?.id === pendingRunId) refreshPythonWatchdog();
  }
  return publishedFinalPose;
}

async function executeNavigationControl(method, args = {}) {
  await waitWhilePaused();
  if (stopRequested) throw new Error("程序已停止。");
  const sceneConfig = currentGuangyangSceneConfig();
  if (!Array.isArray(sceneConfig?.rules?.roads)) {
    throw new Error("道路控制只可用于广阳岛地图。");
  }
  const core = globalThis.CompetitionCore;
  if (!core?.NavigationActionRunner || !core?.NAVIGATION_DEFINITION
    || !core?.NAVIGATION_CONTROL_DEFINITION || !core?.normalizeNavigationControlAction) {
    throw new Error("道路控制尚未就绪，请刷新页面后重试。");
  }
  const action = core.normalizeNavigationControlAction(method, args, core.NAVIGATION_CONTROL_DEFINITION);
  const formalCompetition = isCompetitionMission();
  if (formalCompetition && !competitionSession) {
    throw new Error("正式比赛场次尚未就绪，不能执行道路控制。");
  }
  if (formalCompetition && competitionSession.status !== "running") {
    if (competitionSession.status === "timeout") handleCompetitionTimeout(competitionSession.finalRecord);
    else commitCompetitionRecord(competitionSession.finalRecord);
    throw new Error("当前比赛已经结束，不能继续执行道路控制。");
  }
  const remainingLocalActionSeconds = formalCompetition
    ? Infinity
    : MAX_PROGRAM_ACTION_SECONDS - realtimeRun.totalSeconds;
  if (!formalCompetition && remainingLocalActionSeconds <= 0) {
    throw new Error(`本次程序累计动作时间不能超过 ${MAX_PROGRAM_ACTION_SECONDS} 秒，请分段运行。`);
  }
  realtimeRun.navigationControlCount += 1;
  if (realtimeRun.navigationControlCount > MAX_NAVIGATION_CONTROLS_PER_RUN) {
    throw new Error(`道路控制动作超过 ${MAX_NAVIGATION_CONTROLS_PER_RUN} 次，程序已停止。`);
  }
  realtimeRun.actionCount += 1;
  if (realtimeRun.actionCount > MAX_PROGRAM_ACTION_COUNT) {
    throw new Error(`本次程序动作次数不能超过 ${MAX_PROGRAM_ACTION_COUNT} 次，请检查循环条件。`);
  }
  actionCount += 1;
  blockedMoveCount = 0;
  lastMoveBlocked = false;
  const simulatorCore = ensureDeterministicSimulator();
  const playbackContext = Object.freeze({
    runToken,
    simulator: simulatorCore,
    missionBuildGeneration,
    formalCompetition
  });
  const frames = [];
  let judgement = null;
  let result;
  if (formalCompetition) {
    if (typeof competitionSession.runNavigationControl !== "function") {
      throw new Error("当前比赛核心不支持可复算道路控制，请刷新页面后重试。");
    }
    result = competitionSession.runNavigationControl(simulatorCore, action.method, action.args, {
      onStep: frame => frames.push(frame),
      onJudgement: summary => { judgement = summary; }
    });
  } else {
    simulatorCore.setWorld(simulationWorldDefinition({ includePackages: true }));
    if (!realtimeRun.navigationRoadTopology) {
      realtimeRun.navigationRoadTopology = core.createNavigationTopologyContext(
        sceneConfig.rules,
        core.NAVIGATION_DEFINITION
      );
    }
    const runner = new core.NavigationActionRunner(simulatorCore, {
      rules: sceneConfig.rules,
      navigationDefinition: core.NAVIGATION_DEFINITION,
      navigationControlDefinition: core.NAVIGATION_CONTROL_DEFINITION,
      roadTopology: realtimeRun.navigationRoadTopology
    });
    const remainingTicks = Math.max(0, Math.floor(remainingLocalActionSeconds * 1000 / simulatorCore.config.stepMs));
    result = runner.run(action.method, action.args, {
      onStep: frame => frames.push(frame),
      maxTick: simulatorCore.tick + remainingTicks
    });
  }
  const simulatedSeconds = Math.max(0, Number(result?.elapsedTicks) || 0) * simulatorCore.config.stepMs / 1000;
  realtimeRun.totalSeconds += simulatedSeconds;
  realtimeRun.navigationDistance += cmToWorldUnits(Math.max(0, Number(result?.distanceCm) || 0));
  const controlName = action.method === "follow_road"
    ? `循路最多 ${action.args.maxCm}cm（速度 ${action.args.speed}%）`
    : `驶入出口 ${action.args.roadId}`;
  addLog(`${controlName}：${navigationControlReasonLabel(result?.stoppedBy)}。`);
  setStatus(result?.accepted === false ? "道路控制未执行" : "道路控制执行中");
  const playbackPublished = await playNavigationControlFrames(frames, simulatorCore, playbackContext);
  if (!playbackPublished) return result;
  if (formalCompetition && judgement) {
    renderCompetitionViolations(judgement.violations);
    consumeCompetitionTaskResult(judgement);
    renderCompetitionHud(judgement.score, true);
  }
  if (formalCompetition && competitionSession.status === "timeout") {
    handleCompetitionTimeout(competitionSession.finalRecord);
  } else if (formalCompetition && competitionSession.status === "completed" && !missionAttempt?.completed) {
    commitCompetitionRecord(competitionSession.finalRecord);
    stopRequested = true;
    pauseRequested = false;
    if (pendingPythonRun) cancelPythonCollection("completed");
  }
  lastMoveBlocked = ["front_clearance", "collision", "off_road", "wrong_way"].includes(result?.stoppedBy);
  if (!missionAttempt?.completed && competitionSession?.status !== "completed") {
    setStatus(navigationControlReasonLabel(result?.stoppedBy));
  }
  refreshPythonWatchdog();
  return result;
}

function makeSimRobotApi() {
  return {
    forward: distanceCm => moveRobotDistance(1, distanceCm),
    backward: distanceCm => moveRobotDistance(-1, distanceCm),
    turn: turnRobot,
    turnAngle: turnRobotAngle,
    wait: async seconds => {
      await waitWhilePaused();
      if (stopRequested) return;
      blockedMoveCount = 0;
      lastMoveBlocked = false;
      robotLinearSpeed = 0;
      robotSteering = 0;
      const ms = Math.max(0, Number(seconds) || 0) * 1000;
      addLog(`等待 ${Math.round(ms / 100) / 10} 秒，暂时不发送移动指令。`);
      await runDeterministicCommand({ kind: "wait", durationMs: ms });
    },
    grab: async () => {
      await waitWhilePaused();
      if (stopRequested) return;
      actionCount++;
      const itemName = interactionItemName();
      await runInteractionAnimation(() => animateGripper(true), 480);
      if (stopRequested) return;
      const usesCompetitionInteraction = hasCompetitionInteractionApi();
      const interactionResult = usesCompetitionInteraction ? addCompetitionInteractionInput("grab") : null;
      const grabbed = usesCompetitionInteraction
        ? Boolean(interactionResult?.accepted) && attachPackageToRobot(interactionResult.packageId)
        : attachPackageToRobot();
      if (usesCompetitionInteraction) {
        competitionTick(true);
        if (stopRequested || competitionSession?.status !== "running") {
          settleGripperVisual(grabbed);
          updateRobotTelemetry(undefined, true);
          return;
        }
      }
      if (grabbed) {
        if (!usesCompetitionInteraction) {
          recordCompetitionEvent("package_grabbed", { packageId: heldPackageId, x: robotPose.x, z: robotPose.z });
          competitionTick(true);
        }
        await runInteractionAnimation(liftArmToCarryPosition, 280);
        if (stopRequested && !missionCompletionStopRequested) return;
        setStatus("已抓取包裹");
        addLog(`机械臂抓取成功：${itemName}已固定到夹爪上，并抬起机械臂。`);
      } else {
        setStatus("未抓到包裹");
        const reach = interactionResult || packageReachInfo();
        if (reach.reason === "holding") {
          addLog(`抓取失败：夹爪已经抓着${itemName}。`);
        } else if (reach.reason === "missing" || reach.reason === "not_top") {
          addLog(`抓取失败：场景里没有可抓取的${itemName}。`);
        } else if (reach.reason === "behind") {
          addLog(`抓取失败：${itemName}不在夹爪前方，请让小车正面对准它。`);
        } else if (reach.reason === "side") {
          const lateral = Number(reach.lateral ?? reach.side);
          addLog(`抓取失败：${itemName}偏离夹爪中心${Number.isFinite(lateral) ? ` ${Math.round(worldUnitsToCm(lateral))}cm` : ""}，需要更对准一些。`);
        } else {
          const forward = Number(reach.forward);
          addLog(`抓取失败：${itemName}${Number.isFinite(forward) ? `在前方 ${Math.round(worldUnitsToCm(forward))}cm，` : ""}需要靠近到夹爪范围内。`);
        }
        await runInteractionAnimation(() => animateGripper(false), 420);
      }
      evaluateMissionProgress();
      updateRobotTelemetry(undefined, true);
      if (!robotBackendMode) await sleep(500);
    },
    release: async () => {
      await waitWhilePaused();
      if (stopRequested) return;
      actionCount++;
      const itemName = interactionItemName();
      await runInteractionAnimation(() => animateArmTo(-0.32, 260), 260);
      if (stopRequested) return;
      const usesCompetitionInteraction = hasCompetitionInteractionApi();
      const interactionResult = usesCompetitionInteraction ? addCompetitionInteractionInput("release") : null;
      const releaseState = usesCompetitionInteraction
        ? classifyCompetitionReleaseResult(interactionResult, isHoldingPackage())
        : "local";
      const releaseResult = usesCompetitionInteraction
        ? interactionResult?.accepted && releasePackageFromRobot(interactionResult)
        : releasePackageFromRobot();
      if (usesCompetitionInteraction) {
        competitionTick(true);
        if (stopRequested || competitionSession?.status !== "running") {
          settleGripperVisual(isHoldingPackage());
          updateRobotTelemetry(undefined, true);
          return;
        }
      }
      if (releaseState === "blocked-held" || releaseState === "rejected-held") {
        if (releaseState === "blocked-held") {
          setStatus("放置点被障碍占用");
          addLog(`放置失败：${itemName}的落点被障碍物占用，夹爪继续持有，请移动后重试。`);
        } else {
          setStatus("暂时无法放下物体");
          addLog(`放置失败：${itemName}仍由夹爪持有，请调整位置后重试。`);
        }
        await runInteractionAnimation(liftArmToCarryPosition, 280);
        settleGripperVisual(true);
        evaluateMissionProgress();
        updateRobotTelemetry(undefined, true);
        if (!robotBackendMode) await sleep(500);
        return;
      }
      if (releaseResult) {
        if (!usesCompetitionInteraction) {
          recordCompetitionEvent("package_released", {
            packageId: releaseResult.id,
            position: [...releaseResult.position],
            x: releaseResult.position[0],
            z: releaseResult.position[1]
          });
          competitionTick(true);
        }
        if (!missionAttempt?.completed) setStatus("已放下包裹");
        addLog(`机械臂下降后松开：${itemName}已放下${releaseResult.stackLevel ? `，堆叠在第 ${releaseResult.stackLevel + 1} 层` : ""}。`);
      } else {
        setStatus("夹爪里没有包裹");
        addLog(`松开失败：夹爪里没有${itemName}。`);
      }
      await runInteractionAnimation(() => animateGripper(false), 420);
      evaluateMissionProgress();
      updateRobotTelemetry(undefined, true);
      if (!robotBackendMode) await sleep(500);
    },
    frontBlocked: () => lastMoveBlocked || frontDistance() < FRONT_BLOCKED_DISTANCE,
    distance: () => Math.round(worldUnitsToCm(frontDistance())),
    stopped: () => stopRequested,
    loopTick: async (name, index, total) => {
      addLog(total ? `${name}：第 ${index}/${total} 次。` : `${name}：第 ${index} 次。`);
      await waitWhilePaused();
      await sleep(30);
    },
    loopYield: async () => {
      await waitWhilePaused();
      await sleep(16);
    },
    emptyLoop: async name => {
      addLog(`${name}中没有小车动作。`);
      await waitWhilePaused();
      await sleep(120);
    },
    loopDone: async (name, total) => {
      addLog(total ? `${name}已完成 ${total} 次，所以程序继续往下执行。` : `${name}条件已不成立，循环结束。`);
      await waitWhilePaused();
      await sleep(30);
    },
    loopLimit: async () => {
      stopRequested = true;
      setStatus("循环次数过多，已停止");
      addLog("停止：循环超过 100 次，可能没有退出条件。");
      await sleep(30);
    }
  };
}

function setRealStopHazard(value) {
  realStopHazard = Boolean(value);
  try {
    localStorage.setItem("chenlongRealStopHazard", realStopHazard ? "1" : "0");
  } catch {}
  updateRealRobotControls();
}

function normalizeRobotBaseUrl() {
  const raw = String(robotBaseUrlInput?.value || "192.168.4.1").trim();
  return (/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).replace(/\/+$/, "");
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

async function sendRealRobotAction(action, timeMs = null, context = realtimeRun) {
  const controller = new AbortController();
  realRobotActionController?.abort();
  realRobotActionController = controller;
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const baseUrl = context?.robotBaseUrl || getValidatedRobotBaseUrl();
    const url = new URL(`${baseUrl}/api/control`);
    url.searchParams.set("action", action);
    url.searchParams.set("speed", "50");
    if (timeMs !== null) url.searchParams.set("time", String(Math.max(0, Math.round(timeMs))));
    url.searchParams.set("_", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fetch(url.toString(), { mode: "no-cors", cache: "no-store", signal: controller.signal });
    return !stopRequested;
  } catch (error) {
    if (error?.name === "AbortError" && stopRequested) return false;
    setRealStopHazard(true);
    const detail = error?.name === "AbortError" ? "请求超时" : error.message;
    setStatus("真实小车连接失败");
    addLog(`真实小车指令发送失败：${detail}。如果当前页面是 HTTPS，请改用本地 HTTP 页面控制小车。`);
    throw new Error(`真实小车连接失败：${detail}`);
  } finally {
    clearTimeout(timeoutId);
    if (realRobotActionController === controller) realRobotActionController = null;
  }
}

async function sendRealRobotStop(baseUrl = null) {
  if (realStopPromise) return realStopPromise;
  realStopPending = true;
  setRealStopHazard(true);
  updateRealRobotControls();
  const requestedBaseUrl = baseUrl;
  realStopPromise = (async () => {
    realRobotActionController?.abort();
    realRobotActionController = null;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);
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
      addLog(error?.name === "AbortError"
        ? "真实小车：停止指令发送超时，请立即现场确认。"
        : `真实小车：停止指令发送失败：${error.message}，请立即现场确认。`);
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  })();
  try {
    return await realStopPromise;
  } finally {
    realStopPending = false;
    realStopPromise = null;
    updateRealRobotControls();
  }
}

async function waitRealActionDuration(ms) {
  const startedAt = performance.now();
  while (!stopRequested && performance.now() - startedAt < ms) {
    await waitWhilePaused();
    await sleep(40);
  }
}

function normalizeRealTimedMove(seconds, label) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0.1 || value > REAL_MAX_TIMED_MOVE_SECONDS) {
    throw new RangeError(`真实小车${label}时间必须在 0.1 到 ${REAL_MAX_TIMED_MOVE_SECONDS} 秒之间`);
  }
  return value;
}

async function realMove(action, seconds, label, context) {
  const durationSeconds = normalizeRealTimedMove(seconds, label);
  const durationMs = durationSeconds * 1000;
  addLog(`真实小车：${label} ${Math.round(durationMs / 100) / 10} 秒。`);
  const sent = await sendRealRobotAction(action, durationMs, context);
  if (sent) await waitRealActionDuration(durationMs);
}

async function realMoveCentimeters(action, distanceCm, label, context) {
  const requestedDistanceCm = normalizeDriveDistanceCm(distanceCm);
  const durationMs = requestedDistanceCm / REAL_DRIVE_CM_PER_SECOND * 1000;
  addLog(`真实小车：${label}约 ${Math.round(requestedDistanceCm * 10) / 10} 厘米（按固定速度标定换算）。`);
  const sent = await sendRealRobotAction(action, durationMs, context);
  if (sent) await waitRealActionDuration(durationMs);
}

function makeRealRobotApi(context) {
  return {
    forward: distanceCm => realMoveCentimeters("up", distanceCm, "前进", context),
    backward: distanceCm => realMoveCentimeters("down", distanceCm, "后退", context),
    turn: (direction, seconds) => realMove(direction === "left" ? "left" : "right", seconds,
      direction === "left" ? "左转" : "右转", context),
    turnAngle: (direction, degrees) => {
      const safeDegrees = normalizeTurnDegrees(degrees);
      const side = direction === "left" ? "left" : "right";
      const seconds = Math.max(0.2, Math.min(2.2, safeDegrees / 90 * REAL_TURN_SECONDS_PER_90[side]));
      return realMove(side, seconds, `${side === "left" ? "左转" : "右转"}约 ${safeDegrees}°`, context);
    },
    wait: async seconds => {
      const durationSeconds = Number(seconds);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 500) {
        throw new RangeError("等待时间必须大于 0 秒且不超过 500 秒");
      }
      addLog(`真实小车：等待 ${Math.round(durationSeconds * 10) / 10} 秒，不发送动作。`);
      await waitRealActionDuration(durationSeconds * 1000);
    },
    grab: async () => {
      addLog("真实小车：发送机械臂抓取，预留 6 秒完成动作。");
      const sent = await sendRealRobotAction("grab", null, context);
      if (sent) await waitRealActionDuration(REAL_GRAB_DURATION_MS);
    },
    release: async () => {
      addLog("真实小车：发送机械臂松开，预留 2 秒完成动作。");
      const sent = await sendRealRobotAction("release", null, context);
      if (sent) await waitRealActionDuration(REAL_RELEASE_DURATION_MS);
    }
  };
}

function makeRobotApi() {
  return realtimeRun?.target === "real" ? makeRealRobotApi(realtimeRun) : makeSimRobotApi();
}

function updateRealRobotControls() {
  const locked = running || realStopPending || competitionRunStartPending || replayRunning || replayRecordLoading
    || Boolean(archivedReplayLoadPromise) || Boolean(replayRecordLoadOperation)
    || managedFiveRunIsOpen() || rankedEvaluationLocksWorkspace();
  if (targetSelect) targetSelect.disabled = locked;
  if (robotBaseUrlInput) robotBaseUrlInput.disabled = locked;
  if (applyRobotIpButton) applyRobotIpButton.disabled = locked;
  if (loadExampleButton) loadExampleButton.disabled = locked;
}

function applyRobotIp() {
  try {
    const baseUrl = getValidatedRobotBaseUrl();
    robotBaseUrlInput.value = baseUrl;
    localStorage.setItem("chenlongRobotBaseUrl", baseUrl);
    setStatus("真实小车地址已保存");
    addLog(`真实小车地址：${baseUrl}。浏览器会发送控制指令并显示摄像头画面，但不会收到设备状态确认。`);
    if (targetSelect?.value === "real") void restartRealCameraPreview();
    if (realStopHazard) {
      addLog("上一次停止指令未确认；连接好小车后请先点击“停止”，确认安全后才能运行。", true);
    }
  } catch (error) {
    setStatus("真实小车地址无效");
    addLog(`地址无效：${error.message}`);
  }
}

function setRunTarget(target, { announce = true } = {}) {
  const real = target === "real";
  const wasReal = Boolean(appShell?.classList.contains("is-real-target"));
  if ((running || competitionRunStartPending || replayRunning || replayRecordLoading
    || archivedReplayLoadPromise || replayRecordLoadOperation) && real !== wasReal) {
    if (targetSelect) targetSelect.value = wasReal ? "real" : "sim";
    setStatus("请先停止当前程序再切换运行目标");
    return;
  }
  if (wasReal && !real) {
    void sendRealRobotStop(realtimeRun?.robotBaseUrl || null).then(sent => setRealStopHazard(!sent));
    void stopRealCameraPreview();
  }
  if (targetSelect) targetSelect.value = real ? "real" : "sim";
  appShell?.classList.toggle("is-real-target", real);
  if (scenePanelTitleText) scenePanelTitleText.textContent = real ? "真实小车基础控制" : "3D 模拟器";
  if (real) {
    if (visionApiHelp) visionApiHelp.hidden = true;
    visionApiHelpButton?.setAttribute("aria-expanded", "false");
    startRealCameraPreview();
    if (announce) {
      setStatus("已切换到真实小车（不计分）");
      addLog("真实小车模式支持摄像头实时预览，以及前进、后退、左右转、等待、抓取、松开和停止；画面不提供给 Python 识别，实车也没有定位、传感或任务状态回传。", true);
      addLog("本模式不会创建比赛场次、保存成绩或参与评分。HTTPS 公网页通常不能控制局域网 HTTP 小车，请使用本地 HTTP 页面。", true);
      if (realStopHazard) addLog("上一次停止指令未确认，请先点击“停止”并现场确认小车安全。", true);
    }
  } else if (announce) {
    setStatus("已切换到 3D 模拟器");
    addLog("3D 模拟器支持任务、传感、摄像头和比赛评分。", true);
  }
  updateRobotTelemetry(undefined, true);
  setCompetitionHudVisibility();
  updateRealRobotControls();
  resizeRenderer();
}

function hidePythonFeedback() {
  pythonFeedback.hidden = true;
  pythonFeedbackMessage.textContent = "";
}

function clearPythonOutput() {
  pythonOutput.hidden = true;
  pythonOutputContent.textContent = "";
}

function appendPythonOutput(text) {
  pythonOutputContent.textContent += text;
  pythonOutput.hidden = false;
  pythonOutputContent.scrollTop = pythonOutputContent.scrollHeight;
}

function showPythonFeedback(title, message) {
  pythonFeedbackTitle.textContent = title;
  pythonFeedbackMessage.textContent = message;
  pythonFeedback.hidden = false;
}

function formatPythonError(error) {
  const message = String(error?.message || error).trim();
  const line = findStudentErrorLine(error);
  const location = line ? `第 ${line} 行` : "代码中";
  if (/IndentationError/i.test(message)) return `${location}的缩进不正确。Python 同一层代码要对齐，建议每层使用 4 个空格。`;
  if (/SyntaxError/i.test(message)) return `${location}有语法错误。请检查冒号、括号、英文符号和缩进。`;
  if (/NameError/i.test(message)) return `${location}用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。`;
  if (/TypeError/i.test(message) && /(?:concatenate str.*int|str.*int.*concatenate|unsupported operand type.*str.*int)/i.test(message)) {
    return `${location}不能把文字和数字直接用 + 拼接。请写 str(age)，例如 print("年龄是" + str(age))；也可以写 print("年龄是", age)。`;
  }
  const fixedTurn = message.match(/Robot\.(left_90|right_90)\(\).*positional argument/i)?.[1];
  if (fixedTurn) return `${location}的 robot.${fixedTurn}() 是固定转 90° 的指令，不需要填写秒数。正确写法：robot.${fixedTurn}()`;
  const missingAngle = message.match(/Robot\.(left_angle|right_angle)\(\).*required positional argument/i)?.[1];
  if (missingAngle) return `${location}的 robot.${missingAngle}() 缺少角度。请填写 1 到 360，例如 robot.${missingAngle}(45)。`;
  const missingVisionTarget = message.match(/Robot\.(sees|count|near|centered|direction|distance_to|approach)\(\).*required positional argument/i)?.[1];
  if (missingVisionTarget) return `${location}的 robot.${missingVisionTarget}() 缺少目标名称。示例：robot.${missingVisionTarget}("目标物")`;
  if (/目标名称必须是非空文字/i.test(message)) return `${location}的目标名称不能为空。示例：robot.observe("目标物")`;
  if (/靠近距离必须在 5 到 200 厘米之间/i.test(message)) return `${location}的靠近距离要在 5 到 200 厘米之间，例如 robot.approach("目标物", 100)`;
  if (/距离必须填写数字/i.test(message)) return `${location}的靠近距离必须是数字，例如 robot.approach("目标物", 100)`;
  if (/最大步数必须是 1 到 100 之间的整数/i.test(message)) return `${location}的最大步数必须是 1 到 100 的整数。`;
  if (/置信度必须是 0 到 1 之间的数字/i.test(message)) return `${location}的置信度必须是 0 到 1 的数字，例如 robot.observe("目标物", 0.7)`;
  if (/转向角度必须填写数字/i.test(message)) return `${location}的转向角度必须是数字，例如 robot.left_angle(45)。`;
  if (/转向角度必须是 1 到 360 度之间/i.test(message)) return `${location}的转向角度必须在 1 到 360 度之间，例如 robot.right_angle(135)。`;
  if (/行驶距离必须填写数字/i.test(message)) return `${location}的行驶距离必须是数字，例如 robot.forward(50)。`;
  if (/行驶距离必须在 0\.1 到 500 厘米之间/i.test(message)) return `${location}的行驶距离必须在 0.1 到 500 厘米之间。`;
  if (/TypeError/i.test(message) && /(?:float\(\).*str|must be real number|not a number)/i.test(message)) {
    return `${location}的小车动作参数必须是数字，不能填写文字。`;
  }
  if (/TypeError/i.test(message) && /required positional argument/i.test(message)) {
    return `${location}缺少动作参数。直行请填写厘米数，例如 robot.forward(50)。`;
  }
  if (/TypeError/i.test(message) && /动作时间必须填写数字/i.test(message)) {
    return `${location}的动作时间必须填写数字，例如 robot.left(1)。`;
  }
  if (/TypeError/i.test(message)) return `${location}的参数类型不正确。请检查变量类型和函数括号中的内容。`;
  if (/ValueError/i.test(message) && /动作时间必须/i.test(message)) return `${location}：${message.match(/动作时间必须[^\n]*/)?.[0] || "动作时间不正确。"}`;
  if (/ValueError/i.test(message) && /invalid literal for int\(\)/i.test(message)) {
    return `${location}不能把这段文字转换成整数。int() 里应填写数字文本，例如 int("123")。`;
  }
  if (/ValueError/i.test(message) && /invalid literal for float\(\)/i.test(message)) {
    return `${location}不能把这段文字转换成小数。float() 里应填写数字文本，例如 float("3.14")。`;
  }
  if (/ValueError/i.test(message)) return message.replace(/^.*?ValueError:\s*/is, "");
  return message;
}

function findStudentErrorLine(error) {
  const message = String(error?.message || error);
  return message.match(/File\s+["']<学生代码>["'],\s+line\s+(\d+)/i)?.[1] || null;
}

function escapeHtml(value) {
  return value.replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
}

function renderPythonHighlight() {
  const source = escapeHtml(pythonEditor.value);
  const tokenPattern = /(#.*$)|("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')|\b(for|in|if|elif|else|while|def|return|True|False|None|and|or|not|break|continue)\b|\b(range|print|len|int|float|min|max|abs|round)\b|\b(\d+(?:\.\d+)?)\b|\b(robot)\b|\b(forward|backward|left|right|left_90|right_90|left_angle|right_angle|wait|grab|release|holding|odometry|road_state|map_graph|mission|task_state|release_preview|follow_road|take_exit|sees|count|detect|near|centered|direction|distance_to|observe|approach)(?=\s*\()/gm;
  pythonHighlight.innerHTML = source.replace(tokenPattern, (match, comment, string, keyword, builtin, number, robot, method) => {
    if (comment) return `<span class="token-comment">${match}</span>`;
    if (string) return `<span class="token-string">${match}</span>`;
    if (keyword) return `<span class="token-keyword">${match}</span>`;
    if (builtin) return `<span class="token-builtin">${match}</span>`;
    if (number) return `<span class="token-number">${match}</span>`;
    if (robot) return `<span class="token-robot">${match}</span>`;
    if (method) return `<span class="token-method">${match}</span>`;
    return match;
  });
}

function syncPythonHighlightScroll() {
  pythonHighlight.style.transform = `translate(${-pythonEditor.scrollLeft}px, ${-pythonEditor.scrollTop}px)`;
}

function updateLineNumbers() {
  const count = Math.max(1, pythonEditor.value.split("\n").length);
  const fragment = document.createDocumentFragment();
  for (let line = 1; line <= count; line++) {
    const number = document.createElement("span");
    number.textContent = line;
    if (line === errorLineNumber) number.classList.add("is-error-line");
    fragment.append(number);
  }
  lineNumbers.replaceChildren(fragment);
  lineNumbers.scrollTop = pythonEditor.scrollTop;
  renderPythonHighlight();
  syncPythonHighlightScroll();
}

function clearErrorLine() {
  if (errorLineNumber === null) return;
  errorLineNumber = null;
  updateLineNumbers();
}

function markErrorLine(error) {
  const line = findStudentErrorLine(error);
  errorLineNumber = line ? Number(line) : null;
  updateLineNumbers();
}

function updateLoadingProgress(stage) {
  if (!loadingBarFill || !loadingStatus || !loadingHint) return;
  if (stage === "script") {
    loadingBarFill.style.width = "33%";
    loadingStatus.textContent = "正在加载 Pyodide 引擎…";
    loadingHint.textContent = "正在读取本地 Python 引擎，约 1.2 MB";
  } else if (stage === "runtime") {
    loadingBarFill.style.width = "66%";
    loadingStatus.textContent = "正在初始化 Python 运行时…";
    loadingHint.textContent = "正在读取本地 WASM 与标准库，约 12 MB";
  }
}

function showLoadingError(message) {
  pythonReady = false;
  if (!loadingBarFill || !loadingStatus || !loadingHint) return;
  loadingBarFill.classList.add("is-error");
  loadingBarFill.style.width = "100%";
  loadingStatus.textContent = "Python 环境加载失败";
  loadingHint.innerHTML = `<span class="loading-error">${escapeHtml(message)}</span>`;
  const retryBtn = document.createElement("button");
  retryBtn.className = "loading-retry-button";
  retryBtn.innerHTML = '<i data-lucide="refresh-cw"></i> 重试';
  retryBtn.addEventListener("click", () => {
    loadingBarFill.classList.remove("is-error");
    loadPythonRuntime();
  });
  loadingHint.appendChild(retryBtn);
  if (window.lucide) window.lucide.createIcons();
}

function showSimulationStartupError(message) {
  if (runButton) runButton.disabled = true;
  if (!loadingOverlay || !loadingBarFill || !loadingStatus || !loadingHint) return;
  loadingOverlay.classList.remove("is-hidden");
  loadingBarFill.classList.add("is-error");
  loadingBarFill.style.width = "100%";
  loadingStatus.textContent = "3D 渲染环境启动失败";
  loadingHint.innerHTML = `<span class="loading-error">${escapeHtml(message)}</span>`;
  const retryBtn = document.createElement("button");
  retryBtn.className = "loading-retry-button";
  retryBtn.type = "button";
  retryBtn.textContent = "刷新页面重试";
  retryBtn.addEventListener("click", () => window.location.reload());
  loadingHint.appendChild(retryBtn);
}

function hideLoadingOverlay() {
  if (!loadingOverlay || !runButton) return;
  loadingOverlay.classList.add("is-hidden");
  runButton.disabled = false;
  setTimeout(() => {
    if (loadingOverlay) loadingOverlay.remove();
  }, 400);
}

function resetPythonWorker(showLoading) {
  if (showLoading === undefined) showLoading = true;
  if (pythonWorker) pythonWorker.terminate();
  pythonWorker = new Worker("./python-worker.js?v=20260830-001");
  pythonReady = false;
  pythonRuntimeError = null;
  pythonWorker.onmessage = event => {
    const message = event.data;
    if (message.type === "progress") {
      if (showLoading) updateLoadingProgress(message.stage);
      return;
    }
    if (message.type === "initError") {
      pythonReady = false;
      pythonRuntimeError = message.message || "未知加载错误";
      renderRankedEvaluationPanel();
      if (showLoading) {
        showLoadingError(pythonRuntimeError);
      } else {
        setStatus("Python 环境重启失败，点击运行重试");
        showPythonFeedback("Python 环境重启失败", `${pythonRuntimeError}；点击运行按钮可以重试。`);
        if (runButton) runButton.disabled = false;
      }
      return;
    }
    if (message.type === "ready") {
      pythonReady = true;
      pythonRuntimeError = null;
      if (showLoading) hideLoadingOverlay();
      renderCompetitionBatchPanel();
      renderRankedEvaluationPanel();
      return;
    }
    if (message.type === "output") {
      if (pendingPythonRun) {
        appendPythonOutput(message.text);
        refreshPythonWatchdog();
      }
      return;
    }
    if (message.type === "robot") {
      handleRealtimeRobotRequest(message);
      return;
    }
    if (!pendingPythonRun || message.id !== pendingPythonRun.id) return;
    if (message.type === "done" || message.type === "error") {
      clearTimeout(pendingPythonRun.timer);
      const pending = pendingPythonRun;
      pendingPythonRun = null;
      if (message.type === "done") pending.resolve();
      if (message.type === "error") pending.reject(new Error(message.message));
    }
  };
  pythonWorker.onerror = () => {
    pythonReady = false;
    renderRankedEvaluationPanel();
    if (pendingPythonRun) {
      clearTimeout(pendingPythonRun.timer);
      pendingPythonRun.reject(new Error("Python 运行环境意外停止，请刷新页面后重试。"));
      pendingPythonRun = null;
    } else if (showLoading) {
      showLoadingError("Python 运行环境意外停止");
    }
  };
  pythonWorker.postMessage({ type: "init" });
}

function loadPythonRuntime() {
  if (runButton) runButton.disabled = true;
  if (loadingOverlay) {
    loadingOverlay.classList.remove("is-hidden");
    if (loadingBarFill) {
      loadingBarFill.classList.remove("is-error");
      loadingBarFill.style.width = "0%";
    }
    if (loadingStatus) loadingStatus.textContent = "正在加载 Pyodide 脚本…";
    if (loadingHint) loadingHint.textContent = "";
  }
  resetPythonWorker(true);
}

function getVisionSnapshot() {
  return {
    source: "virtual-camera",
    objects: window.CarVision?.getDetections?.() || []
  };
}

function refreshPythonWatchdog(timeout = 5000) {
  if (!pendingPythonRun) return;
  clearTimeout(pendingPythonRun.timer);
  pendingPythonRun.watchdogTimeout = timeout;
  const id = pendingPythonRun.id;
  pendingPythonRun.timer = setTimeout(() => {
    if (!pendingPythonRun || pendingPythonRun.id !== id) return;
    const pending = pendingPythonRun;
    pendingPythonRun = null;
    realtimeRun = null;
    resetPythonWorker(false);
    pending.reject(new Error("代码连续 5 秒没有执行动作、识别或输出，可能存在无限循环，例如 while True。"));
  }, timeout);
}

function normalizeVisionName(value) {
  return String(value || "").trim().toLowerCase();
}

function canonicalVisionCategory(object) {
  const explicit = normalizeTrainingVisionCategory(object?.category);
  if (explicit) return explicit;
  const label = String(object?.label || "").trim();
  if (["目标物", "红球"].includes(label)) return "target";
  if (["障碍物", "黄黑障碍"].includes(label)) return "obstacle";
  if (["混淆物", "干扰物", "蓝球", "蓝色混淆物"].includes(label)) return "distractor";
  if (["存放点", "存放区"].includes(label)) return "storage-zone";
  if (["清理点", "清理区"].includes(label)) return "cleanup-zone";
  return null;
}

function requireTrainingVisionCategory(value) {
  const category = normalizeTrainingVisionCategory(value);
  if (!category) {
    throw new Error(`观察类别必须精确填写：${TRAINING_VISION_CATEGORIES.join("、")}`);
  }
  return category;
}

function safeVisionObservation(object) {
  const confidence = Number(object?.confidence);
  const category = canonicalVisionCategory(object);
  return {
    category: category,
    categoryLabel: trainingVisionCategoryLabel(category),
    name: object?.label || trainingVisionCategoryLabel(category),
    label: object?.label || trainingVisionCategoryLabel(category),
    direction: object?.direction || "中间",
    bearingDeg: Number.isFinite(Number(object?.bearingDeg))
      ? Number(Number(object.bearingDeg).toFixed(2)) : null,
    distanceCm: displayDistanceCm(object),
    confidence: Number.isFinite(confidence) ? Number(confidence.toFixed(2)) : 0,
    near: Boolean(object?.near) && isCenteredVisionObject(object),
    stable: isStableVisionObject(object)
  };
}

function visionObjectMatches(target, object) {
  const wanted = normalizeVisionName(target);
  if (!wanted) return false;
  const wantedCategory = normalizeTrainingVisionCategory(target);
  if (wantedCategory) {
    return canonicalVisionCategory(object) === wantedCategory;
  }
  const names = [object.label, ...(object.aliases || [])].map(normalizeVisionName);
  const exactMatch = names.includes(wanted);
  // A student-defined name is an exact contract. For example, a target taught
  // as “球” must not silently answer to “红球” through the simulator aliases.
  if (object?.source === "teaching") return exactMatch;
  if (exactMatch) return true;
  const ballAliases = ["红球", "球"];
  if (ballAliases.includes(wanted)) return names.some(name => ballAliases.includes(name));
  const packageAliases = ["包裹", "纸箱", "箱子"];
  if (packageAliases.includes(wanted)) return names.some(name => packageAliases.includes(name));
  if (["障碍", "障碍物", "方块"].includes(wanted)) return names.some(name => ["障碍", "障碍物", "方块"].includes(name));
  return false;
}

function isObstacleQuery(target) {
  return ["障碍", "障碍物", "方块", "墙", "墙壁", "边界"].includes(normalizeVisionName(target));
}

function isObstacleObject(object) {
  return object.label === "障碍物" || object.label === "墙壁";
}

function shouldAvoidObject(object) {
  // `distance` is measured to an object's centre. `clearance` is the actual
  // driving room left before a collision, so narrow corridors remain usable.
  return !isObstacleObject(object) || (object.clearance ?? object.distance) <= 0.8;
}

function isBlockingApproachObstacle(object, targetObject) {
  if (!isStableVisionObject(object)
    || !isCenteredVisionObject(object)
    || !shouldAvoidObject(object)
    || visionObjectsOverlap(object, targetObject)) return false;
  if (String(object?.source || "").startsWith("virtual")
    && String(targetObject?.source || "").startsWith("virtual")) {
    const obstacleDistance = Number(object.distance);
    const targetDistance = Number(targetObject.distance);
    // The obstacle can be visible in the same ray while physically sitting
    // behind the target. It cannot block the path used to approach that target.
    if (Number.isFinite(obstacleDistance)
      && Number.isFinite(targetDistance)
      && obstacleDistance > targetDistance + APPROACH_REAR_OBSTACLE_MARGIN) return false;
  }
  return true;
}

function readVisionObjects(confidence = 0.6) {
  const threshold = Number(confidence);
  const minimum = Number.isFinite(threshold) ? threshold : 0.6;
  const now = Date.now();
  return getVisionSnapshot().objects.filter(object => (
    object.confidence >= minimum
    && (object.source !== "yolo" || !object.capturedAt || now - object.capturedAt <= 1800)
  ));
}

function ensureRealtimeVisionFrame() {
  const vision = window.CarVision?.getStatus?.();
  if (vision?.error) throw new Error(`虚拟车载摄像头识别不可用：${vision.error}`);
  if (!vision?.fresh || vision.source !== "virtual") {
    throw new Error("虚拟车载摄像头画面尚未就绪或已过期。请稍后再使用 robot.observe() 等摄像头指令。");
  }
}

function projectSimpleVisionQuery(method, args) {
  ensureRealtimeVisionFrame();
  const projectQuery = window.CarVisionPixelCore?.projectQuery;
  if (typeof projectQuery !== "function") {
    throw new Error("虚拟摄像头查询核心未加载，无法完成视觉识别。");
  }
  const getDetections = window.CarVision?.getDetections;
  if (typeof getDetections !== "function") {
    throw new Error("虚拟摄像头识别结果不可用，请刷新页面后重试。");
  }
  return projectQuery(method, args, getDetections.call(window.CarVision));
}

function sortVisionMatches(target, objects) {
  const wanted = normalizeVisionName(target);
  return [...objects].sort((a, b) => {
    const aExact = normalizeVisionName(a.label) === wanted ? 1 : 0;
    const bExact = normalizeVisionName(b.label) === wanted ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const aTeaching = a.source === "teaching" ? 1 : 0;
    const bTeaching = b.source === "teaching" ? 1 : 0;
    if (aTeaching !== bTeaching) return bTeaching - aTeaching;
    const aDistance = Number.isFinite(a.distance) ? 1 : 0;
    const bDistance = Number.isFinite(b.distance) ? 1 : 0;
    if (aDistance !== bDistance) return bDistance - aDistance;
    return b.confidence - a.confidence;
  });
}

function getMatchingVisionObjects(target, confidence = 0.6) {
  ensureRealtimeVisionFrame();
  const objects = readVisionObjects(confidence);
  if (target === null || target === undefined || target === "") return objects;
  return sortVisionMatches(target, objects.filter(object => visionObjectMatches(target, object)));
}

function getExactCategoryVisionObjects(category, confidence = 0.6) {
  const exactCategory = category === null || category === undefined || category === ""
    ? null
    : requireTrainingVisionCategory(category);
  ensureRealtimeVisionFrame();
  const supportedObjects = readVisionObjects(confidence).filter(object => canonicalVisionCategory(object));
  return sortVisionMatches(
    exactCategory || "",
    exactCategory
      ? supportedObjects.filter(object => canonicalVisionCategory(object) === exactCategory)
      : supportedObjects
  );
}

function isCenteredVisionObject(object) {
  return object?.direction === "中间";
}

function isStableVisionObject(object) {
  return object?.stable !== false;
}

function displayDistanceCm(object) {
  return Number.isFinite(object?.distance) ? Math.round(worldUnitsToCm(object.distance)) : null;
}

function visionObjectsOverlap(a, b) {
  if (!a?.box || !b?.box) return false;
  const left = Math.max(a.box.x, b.box.x);
  const top = Math.max(a.box.y, b.box.y);
  const right = Math.min(a.box.x + a.box.width, b.box.x + b.box.width);
  const bottom = Math.min(a.box.y + a.box.height, b.box.y + b.box.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.box.width * a.box.height + b.box.width * b.box.height - intersection;
  return intersection / Math.max(1, union) >= 0.18;
}

function visionHorizontalOffset(object) {
  if (object?.box && Number.isFinite(object.box.x) && Number.isFinite(object.box.width)) {
    const center = object.box.x + object.box.width / 2;
    return Math.max(-1, Math.min(1, (center - 320) / 320));
  }
  if (object?.direction === "左") return -0.28;
  if (object?.direction === "右") return 0.28;
  return 0;
}

function isApproachCentered(object) {
  // Fixed-step turns have a minimum 80 ms pulse. A narrow camera deadband makes
  // a centred object alternate left/right forever instead of advancing, so the
  // steering tolerance must be wider than one minimum turn pulse.
  const tolerance = object?.near ? 0.22 : 0.27;
  return Math.abs(visionHorizontalOffset(object)) <= tolerance;
}

function approachSteeringAction(object) {
  if (isApproachCentered(object)) return "forward";
  return visionHorizontalOffset(object) < 0 ? "left" : "right";
}

function approachTargetSummary(object) {
  if (!object) return null;
  const finiteOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    label: String(object.label || ""),
    confidence: finiteOrNull(object.confidence),
    distance: finiteOrNull(object.distance),
    minimumApproachDistance: finiteOrNull(object.minimumApproachDistance),
    direction: String(object.direction || ""),
    near: Boolean(object.near),
    stable: isStableVisionObject(object),
    horizontalOffset: finiteOrNull(visionHorizontalOffset(object))
  };
}

function addCompetitionApproachStepQuery(target, distanceCm, step, result, frameId) {
  const normalizedDistance = Number(distanceCm);
  return addCompetitionVisionQuery("approach_step", [
    target === null || target === undefined ? null : String(target),
    Number.isFinite(normalizedDistance) ? normalizedDistance : null,
    Number.isSafeInteger(step) && step >= 0 ? step : 0
  ], result, frameId);
}

function approachActionSeconds(object, action, requestedDistance) {
  const distance = Number(object?.distance);
  const closeToGoal = Boolean(object?.near)
    || (Number.isFinite(requestedDistance) && Number.isFinite(distance) && distance <= requestedDistance * 1.8);
  if (action === "forward") {
    // Use smaller pulses near the pickup distance to avoid overshooting.
    if (closeToGoal) return 0.1;
    if (Number.isFinite(requestedDistance) && Number.isFinite(distance) && distance <= requestedDistance * 2.8) return 0.14;
    return 0.18;
  }
  const offset = Math.abs(visionHorizontalOffset(object));
  const maximum = closeToGoal ? 0.09 : 0.11;
  return Math.max(0.08, Math.min(maximum, 0.065 + offset * 0.09));
}

function approachTurnDegrees(object) {
  return Math.max(2, Math.min(6, Math.abs(visionHorizontalOffset(object)) * 10));
}

function hasReachedApproachDistance(object, requestedDistance) {
  const distance = Number(object?.distance);
  if (!Number.isFinite(distance)) return false;
  const suppliedCollisionLimit = object?.minimumApproachDistance;
  const collisionLimit = suppliedCollisionLimit === null || suppliedCollisionLimit === undefined
    ? null : Number(suppliedCollisionLimit);
  const category = String(object?.category || "").trim().toLowerCase();
  const grabbableMargin = category === "target" || category === "distractor" ? 0.3 : 0.02;
  const minimumReachable = Number.isFinite(collisionLimit) ? collisionLimit + grabbableMargin : 0;
  // Targets, distractors, and destination signs publish a category-specific
  // safe stopping distance.  A large student search distance (for example
  // 100 cm) must not make approach() report success while the package is still
  // outside the gripper range.  Obstacles have no such stop distance, so their
  // explicit requested distance remains authoritative.
  if (minimumReachable > 0) return distance <= minimumReachable;
  if (requestedDistance === null) return Boolean(object?.near);
  return distance <= requestedDistance * 1.08;
}

function approachActionSpeed(object, action, requestedDistance) {
  const distance = Number(object?.distance);
  const closeToGoal = Boolean(object?.near)
    || (Number.isFinite(requestedDistance) && Number.isFinite(distance) && distance <= requestedDistance * 1.8);
  if (action === "forward") {
    // approach() chooses motion on the student's behalf, so its linear pulses
    // stay at or below 30%. Guangyang's 2.5 internal units/s equal
    // 31.25 cm/s, so this helper stays at or below 9.375 cm/s.
    if (closeToGoal) return 24;
    if (Number.isFinite(requestedDistance) && Number.isFinite(distance) && distance <= requestedDistance * 2.8) return 28;
    return 30;
  }
  return closeToGoal ? 24 : 30;
}

async function waitForNewVisionFrame(previousFrameId) {
  await waitWhilePaused();
  if (stopRequested) throw new Error("程序已停止。");
  await startVirtualCameraVision();
  const vision = window.CarVision?.getStatus?.();
  return vision?.source === "virtual" && vision.fresh && vision.frameId > (previousFrameId ?? -1) ? vision : null;
}

async function waitForApproachVisionFrames(previousFrameId) {
  return await waitForNewVisionFrame(previousFrameId) ? [] : null;
}

function actionDuration(action, args, options = {}) {
  if (["forward", "backward"].includes(action)) {
    if (options.timedDrive) return Number(args[0]);
    return realtimeRun?.target === "real"
      ? normalizeDriveDistanceCm(args[0]) / REAL_DRIVE_CM_PER_SECOND
      : driveDistancePlan(args[0]).durationMs / 1000;
  }
  if (["left", "right", "wait"].includes(action)) return Number(args[0]);
  if (["left_90", "right_90"].includes(action)) return 0.5;
  if (["left_angle", "right_angle"].includes(action)) return turnAngleDurationSeconds(args[0]);
  if (action === "grab") return GRAB_ACTION_DURATION_SECONDS;
  if (action === "release") return RELEASE_ACTION_DURATION_SECONDS;
  return 0;
}

function isRealtimeAction(method) {
  return ["forward", "backward", "left", "right", "left_90", "right_90", "left_angle", "right_angle", "wait", "grab", "release"].includes(method);
}

async function executeRealtimeAction(method, args = [], options = {}) {
  if (!isRealtimeAction(method)) throw new Error(`不支持的指令：${method}`);
  const duration = actionDuration(method, args, options);
  if (!Number.isFinite(duration) || duration < 0) throw new Error("动作时间不正确。");
  realtimeRun.actionCount += 1;
  if (realtimeRun.actionCount > MAX_PROGRAM_ACTION_COUNT) {
    throw new Error(`本次程序动作次数不能超过 ${MAX_PROGRAM_ACTION_COUNT} 次，请检查循环条件。`);
  }
  realtimeRun.totalSeconds += duration;
  if (realtimeRun.totalSeconds > MAX_PROGRAM_ACTION_SECONDS) {
    throw new Error(`本次程序累计动作时间不能超过 ${MAX_PROGRAM_ACTION_SECONDS} 秒，请分段运行。`);
  }
  refreshPythonWatchdog(Math.max(5000, Math.ceil(duration * 1000) + 5000));
  await executePythonCommand(realtimeRun.robot, {
    action: method,
    value: args[0],
    speed: options.speed,
    timedDrive: options.timedDrive === true
  });
  if (stopRequested && !missionCompletionStopRequested) throw new Error("程序已停止。");
  refreshPythonWatchdog();
}

async function approachVisionTarget(target, distanceCm, maxSteps) {
  const requestedDistance = distanceCm === null || distanceCm === undefined
    ? null : cmToWorldUnits(Number(distanceCm));
  const allowedSteps = Number.isInteger(maxSteps)
    ? Math.max(1, Math.min(MAX_APPROACH_STEPS, maxSteps))
    : DEFAULT_APPROACH_MAX_STEPS;
  const completionStopActiveAtStart = missionCompletionStopRequested;
  let unstableFrames = 0;
  let actionsTaken = 0;
  let reuseCapturedFrame = false;
  while (actionsTaken <= allowedSteps) {
    await waitWhilePaused();
    refreshPythonWatchdog();
    if (stopRequested) {
      if (missionCompletionStopRequested && !completionStopActiveAtStart) return true;
      if (missionCompletionStopRequested) {
        addLog("任务已经完成，小车保持停车，不再执行自动靠近。");
        return false;
      }
      throw new Error("程序已停止。");
    }
    if (!reuseCapturedFrame) await startVirtualCameraVision();
    reuseCapturedFrame = false;
    ensureRealtimeVisionFrame();
    const visionBeforeMove = window.CarVision?.getStatus?.();
    const matchingObjects = getMatchingVisionObjects(target);
    const targetObject = matchingObjects.find(isStableVisionObject) || matchingObjects[0];
    const approachStep = actionsTaken + 1;
    if (!targetObject || !isStableVisionObject(targetObject)) {
      unstableFrames += 1;
      addCompetitionApproachStepQuery(target, distanceCm, approachStep, {
        action: null,
        decision: unstableFrames >= APPROACH_LOST_FRAME_LIMIT ? "stop_unstable_target" : "retry_unstable_target",
        target: approachTargetSummary(targetObject)
      }, visionBeforeMove?.frameId ?? null);
      if (unstableFrames >= APPROACH_LOST_FRAME_LIMIT) {
        addLog(`自动靠近已停止：没有稳定识别到“${target}”。`);
        return false;
      }
      const nextVision = await waitForNewVisionFrame(visionBeforeMove?.frameId);
      if (!nextVision) {
        addCompetitionApproachStepQuery(target, distanceCm, approachStep, {
          action: null,
          decision: "stop_no_new_frame",
          target: approachTargetSummary(targetObject)
        }, window.CarVision?.getStatus?.().frameId ?? visionBeforeMove?.frameId ?? null);
        addLog("自动靠近已停止：虚拟摄像头画面没有继续更新。");
        return false;
      }
      reuseCapturedFrame = true;
      continue;
    }
    unstableFrames = 0;
    if (!Number.isFinite(targetObject.distance)) {
      addCompetitionApproachStepQuery(target, distanceCm, approachStep, {
        action: null,
        decision: "stop_missing_distance",
        target: approachTargetSummary(targetObject)
      }, visionBeforeMove?.frameId ?? null);
      addLog(`自动靠近已停止：“${target}”没有可用的距离估算，请确认场景目标已正确生成。`);
      return false;
    }

    const reachedDistance = hasReachedApproachDistance(targetObject, requestedDistance);
    const approachCentered = isApproachCentered(targetObject);
    if (reachedDistance && approachCentered) {
      addCompetitionApproachStepQuery(target, distanceCm, approachStep, {
        action: null,
        decision: "stop_reached",
        target: approachTargetSummary(targetObject)
      }, visionBeforeMove?.frameId ?? null);
      blockedMoveCount = 0;
      lastMoveBlocked = false;
      setStatus("已靠近目标");
      updateRobotTelemetry(undefined, true);
      addLog(`已靠近“${target}”（估算 ${displayDistanceCm(targetObject)}cm，正对目标）。`);
      return true;
    }
    // max_steps counts actual motion pulses, not camera observations. Always
    // inspect the frame after the final pulse before reporting failure.
    if (actionsTaken >= allowedSteps) {
      addCompetitionApproachStepQuery(target, distanceCm, approachStep, {
        action: null,
        decision: "stop_step_limit",
        target: approachTargetSummary(targetObject)
      }, visionBeforeMove?.frameId ?? null);
      break;
    }

    const steeringAction = approachSteeringAction(targetObject);
    if (steeringAction === "forward") {
      const blockingObject = getMatchingVisionObjects("障碍", 0.45)
        .find(object => isBlockingApproachObstacle(object, targetObject));
      if (blockingObject) {
        addCompetitionApproachStepQuery(target, distanceCm, approachStep, {
          action: null,
          decision: "stop_obstacle",
          target: approachTargetSummary(targetObject),
          obstacle: approachTargetSummary(blockingObject)
        }, visionBeforeMove?.frameId ?? null);
        addLog(`自动靠近已停止：正前方检测到障碍物，距离约 ${displayDistanceCm(blockingObject) ?? "未知"}${displayDistanceCm(blockingObject) === null ? "" : "cm"}。`);
        return false;
      }
    }
    const turnDegrees = steeringAction === "forward" ? null : approachTurnDegrees(targetObject);
    const action = steeringAction === "forward" ? "forward" : `${steeringAction}_angle`;
    const seconds = steeringAction === "forward"
      ? approachActionSeconds(targetObject, steeringAction, requestedDistance)
      : null;
    const speed = steeringAction === "forward"
      ? approachActionSpeed(targetObject, steeringAction, requestedDistance)
      : null;
    const motionName = steeringAction === "forward" ? "小步前进" : steeringAction === "left" ? "微调左转" : "微调右转";
    const step = actionsTaken + 1;
    addCompetitionApproachStepQuery(target, distanceCm, step, {
      action,
      seconds,
      angleDegrees: turnDegrees,
      speed,
      decision: "control",
      target: approachTargetSummary(targetObject)
    }, visionBeforeMove?.frameId ?? null);
    addLog(`自动靠近“${target}”：第 ${step}/${allowedSteps} 步，${motionName} ${turnDegrees === null ? `${seconds.toFixed(2)} 秒` : `${turnDegrees.toFixed(1)}°`}。`);
    await executeRealtimeAction(action, [turnDegrees ?? seconds], { speed, timedDrive: action === "forward" || action === "backward" });
    actionsTaken += 1;
    const nextFrame = await waitForApproachVisionFrames(visionBeforeMove?.frameId);
    if (!nextFrame) {
      addCompetitionApproachStepQuery(target, distanceCm, actionsTaken + 1, {
        action: null,
        decision: "stop_no_new_frame",
        target: null
      }, window.CarVision?.getStatus?.().frameId ?? visionBeforeMove?.frameId ?? null);
      addLog("自动靠近已停止：虚拟摄像头画面没有继续更新，为安全起见不再移动。");
      return false;
    }
    reuseCapturedFrame = true;
  }
  addLog(`自动靠近已停止：在 ${allowedSteps} 步内没有安全到达“${target}”。`);
  return false;
}

async function handleRealtimeRobotRequest(message) {
  const requestWorker = pythonWorker;
  const requestRunId = pendingPythonRun?.id;
  const method = message?.method;
  const args = Array.isArray(message?.args) ? message.args : [];
  const visionMethods = ["sees", "count", "detect", "near", "centered", "direction", "distance_to", "approach", "observe"];
  const reply = (result, error = "") => {
    if (!requestWorker || pythonWorker !== requestWorker || pendingPythonRun?.id !== requestRunId) return;
    requestWorker.postMessage({ type: "robotResult", id: message.id, result: JSON.stringify(result), error });
  };
  try {
    if (!pendingPythonRun || !realtimeRun || !realtimeRun.robot) throw new Error("当前程序已经停止。");
    if (realtimeRun.target === "real" && !isRealtimeAction(method)) {
      throw new Error(`真实小车摄像头只供人工预览，不向 Python 提供感知、定位或任务状态回传，不能使用 robot.${method}()；仅支持前进、后退、左右转、等待、抓取和松开。`);
    }
    if (["odometry", "road_state", "map_graph", "mission", "task_state", "release_preview"].includes(method)) {
      if (args.length !== 0) throw new TypeError(`${method} 不接受参数。`);
      await waitWhilePaused();
      if (stopRequested) throw new Error("当前程序已经停止。");
      realtimeRun.navigationQueryCount += 1;
      if (realtimeRun.navigationQueryCount > MAX_NAVIGATION_QUERIES_PER_RUN) {
        throw new Error(`导航传感器查询超过 ${MAX_NAVIGATION_QUERIES_PER_RUN} 次，程序已停止。`);
      }
      const result = readNavigationSensor(method);
      refreshPythonWatchdog();
      reply(result);
      return;
    }
    if (method === "follow_road" || method === "take_exit") {
      const validCount = args.length === 2 || args.length === 3;
      if (!validCount) throw new TypeError(`${method} 参数数量不正确。`);
      const result = await executeNavigationControl(method, method === "follow_road"
        ? { maxCm: args[0], speed: args[1], obeySpeedLimit: args.length === 3 ? args[2] : false }
        : { roadId: args[0], speed: args[1], obeySpeedLimit: args.length === 3 ? args[2] : false });
      reply(result);
      return;
    }
    if (method === "holding") {
      const category = heldObjectCategory();
      const result = category ? trainingVisionCategoryLabel(category) : null;
      refreshPythonWatchdog();
      renderObjectTrainingPanel();
      reply(result);
      return;
    }
    if (["sees", "count", "detect", "near", "centered", "direction", "distance_to", "observe"].includes(method)) {
      const capturedFrame = await startVirtualCameraVision();
      const observedFrameId = capturedFrame?.frameId ?? window.CarVision?.getStatus?.().frameId ?? null;
      const result = projectSimpleVisionQuery(method, args);
      refreshPythonWatchdog();
      addCompetitionVisionQuery(method, args, result, observedFrameId);
      renderObjectTrainingPanel();
      reply(result);
      return;
    }

    if (method === "approach") {
      const result = await approachVisionTarget(args[0], args[1], args[2]);
      refreshPythonWatchdog();
      const observedFrameId = window.CarVision?.getStatus?.().frameId ?? null;
      addCompetitionVisionQuery(method, args, result, observedFrameId);
      reply(result);
      return;
    }

    if (realtimeRun.target === "real" && !realtimeRun.dispatchStarted) {
      realtimeRun.dispatchStarted = true;
      setStatus("程序检查通过，正在发送真实小车指令");
      addLog("真实小车程序已完整检查通过，开始按顺序发送基础动作。", true);
    }
    await executeRealtimeAction(method, args);
    reply(null);
  } catch (error) {
    if (visionMethods.includes(method)) {
      const observedFrameId = window.CarVision?.getStatus?.().frameId ?? null;
      addCompetitionVisionQuery(method, args, { error: error.message || String(error) }, observedFrameId);
    }
    reply(null, error.message || String(error));
  }
}

function runPythonProgram(source, target = "sim") {
  if (!pythonReady) return Promise.reject(new Error("Python 还在准备中，请稍等几秒再运行。"));
  return new Promise((resolve, reject) => {
    const id = ++pythonRequestId;
    pendingPythonRun = { id, resolve, reject, timer: null };
    refreshPythonWatchdog();
    pythonWorker.postMessage({ type: "run", id, source, target: target === "real" ? "real" : "sim" });
  });
}

function cancelPythonCollection(reason = "cancelled") {
  missionCompletionStopRequested = false;
  const real = realtimeRun?.target === "real";
  const competitionRecord = real ? null : finishCompetitionRun(reason);
  if (!pendingPythonRun) {
    realtimeRun = null;
    return competitionRecord;
  }
  const pending = pendingPythonRun;
  pendingPythonRun = null;
  realtimeRun = null;
  clearTimeout(pending.timer);
  resetPythonWorker(false);
  pending.reject(new Error("已停止当前程序。"));
  return competitionRecord;
}

async function executePythonCommand(robot, command) {
  const value = Number(command.value) || 0;
  if (command.action === "forward") return command.timedDrive
    ? moveRobot(1, value, command.speed)
    : robot.forward(value);
  if (command.action === "backward") return command.timedDrive
    ? moveRobot(-1, value, command.speed)
    : robot.backward(value);
  if (command.action === "left") return robot.turn("left", value, command.speed);
  if (command.action === "right") return robot.turn("right", value, command.speed);
  if (command.action === "left_90") return robot.turnAngle("left", 90);
  if (command.action === "right_90") return robot.turnAngle("right", 90);
  if (command.action === "left_angle") return robot.turnAngle("left", normalizeTurnDegrees(value));
  if (command.action === "right_angle") return robot.turnAngle("right", normalizeTurnDegrees(value));
  if (command.action === "wait") return robot.wait(value);
  if (command.action === "grab") return robot.grab();
  if (command.action === "release") return robot.release();
  throw new Error(`不支持的指令：${command.action}`);
}

async function runProgram(options = {}) {
  const batchManaged = options?.batchManaged === true;
  const rankedManaged = options?.rankedManaged === true;
  const fiveRunManaged = batchManaged || rankedManaged;
  const managedActive = rankedManaged ? activeRankedEvaluation : batchManaged ? activeCompetitionBatch : null;
  if ((managedFiveRunIsOpen() || rankedEvaluationLocksWorkspace()) && !fiveRunManaged) {
    setStatus(rankedEvaluationIsOpen()
      ? "筛选五局已锁定源码并自动运行，请使用筛选面板控制"
      : "练习五局已锁定源码并自动运行（不入榜），请使用练习面板控制");
    return;
  }
  if (rankedManaged && !rankedEvaluationIsOpen()) throw new Error("筛选五局运行状态已经变化");
  if (batchManaged && !competitionBatchIsOpen()) throw new Error("练习五局运行状态已经变化");
  if (running || competitionRunStartPending) return;
  if (realStopPending) {
    setStatus("正在发送停止指令，请稍候");
    return;
  }
  if (replayRunning) {
    stopCompetitionReplay();
    setStatus("已请求停止回放，请再次运行");
    return;
  }
  if (replayRecordLoading || archivedReplayLoadPromise || replayRecordLoadOperation) {
    stopCompetitionReplay();
    setStatus("已取消后台存档载入，正在启动新运行");
  }
  const source = fiveRunManaged ? String(managedActive?.source || "") : pythonEditor.value.trim();
  if (!source) {
    setStatus("请先写 Python 代码");
    return;
  }
  if (fiveRunManaged && targetSelect?.value === "real") {
    throw new Error("真实小车不参与练习五局或筛选五局，请先切回 3D 模拟器");
  }
  const target = targetSelect?.value === "real" ? "real" : "sim";
  if (!pythonReady) {
    if (pythonRuntimeError) {
      setStatus("正在重试 Python 环境");
      hidePythonFeedback();
      resetPythonWorker(false);
    } else {
      setStatus("Python 还在准备中");
    }
    return;
  }
  let robotBaseUrl = null;
  if (target === "real") {
    if (realStopHazard) {
      setStatus("请先发送停止指令并现场确认安全");
      addLog("真实小车上一次停止指令未确认。请连接小车、检查地址并点击“停止”，成功发送后再运行。", true);
      return;
    }
    try {
      robotBaseUrl = getValidatedRobotBaseUrl();
    } catch (error) {
      setStatus("真实小车地址无效");
      addLog(`地址无效：${error.message}`);
      return;
    }
  }
  if (target === "sim" && isCompetitionMission()) {
    missionAttempt = null;
    restoreMissionBaseline();
    resetRobot();
    rebuildSceneObjects();
    initializeMissionAttempt();
  }
  // Basic driving must remain available while the camera/YOLO is starting.
  // Vision-specific calls report a line-level error only when the student uses them.
  const currentRunToken = ++runToken;
  running = true;
  if (competitionTeamIdInput) competitionTeamIdInput.disabled = isCompetitionMission();
  stopRequested = false;
  missionCompletionStopRequested = false;
  pauseRequested = false;
  actionCount = 0;
  blockedMoveCount = 0;
  lastMoveBlocked = false;
  clearActionLog();
  setStatus(target === "real" ? "正在检查真实小车 Python 程序" : "正在运行 Python");
  hidePythonFeedback();
  clearPythonOutput();
  clearErrorLine();
  closeExampleMenu();
  addLog(target === "real"
    ? `正在完整检查并生成 ${robotBaseUrl} 的基础动作计划；全部通过后才会开始发送。实车没有感知回传，本次不创建比赛场次、不保存成绩。`
    : "从当前位置开始运行 Python 程序。", true);
  updateRealRobotControls();
  let competitionReady = target === "real";
  if (target === "sim") {
    try {
      competitionReady = await startCompetitionRun(source, currentRunToken);
    } catch (error) {
      running = false;
      updateRealRobotControls();
      if (competitionTeamIdInput) competitionTeamIdInput.disabled = managedFiveRunIsOpen();
      const message = String(error?.message || error).slice(0, 160);
      setStatus("比赛场次启动失败");
      addLog(`比赛场次启动失败：${message}。`);
      showPythonFeedback("比赛场次启动失败", message);
      if (fiveRunManaged) throw error;
      return;
    }
  }
  if (!competitionReady || currentRunToken !== runToken || stopRequested) {
    running = false;
    updateRealRobotControls();
    if (competitionTeamIdInput) competitionTeamIdInput.disabled = managedFiveRunIsOpen();
    const managedStopRequested = rankedManaged
      ? activeRankedEvaluation?.stopRequested
      : activeCompetitionBatch?.stopBatchRequested;
    if (fiveRunManaged && !managedStopRequested) {
      throw new Error("当前局在启动完成前被取消");
    }
    return;
  }
  let programFailed = false;
  let runContext = null;

  try {
    runContext = {
      target,
      robotBaseUrl,
      dispatchStarted: false,
      robot: null,
      actionCount: 0,
      totalSeconds: 0,
      navigationOrigin: { x: robotPose.x, z: robotPose.z, heading: robotPose.heading },
      navigationStartTick: deterministicSimulator?.tick ?? 0,
      navigationDistance: 0,
      navigationQueryCount: 0,
      navigationControlCount: 0,
      navigationRoadTopology: null
    };
    realtimeRun = runContext;
    runContext.robot = makeRobotApi();
    await runPythonProgram(source, target);
    if (currentRunToken === runToken) {
      if (target === "real" && !stopRequested) {
        setStatus("真实小车程序已执行");
        addLog("Python 基础动作已执行完毕；系统未收到实车状态，也没有生成比赛成绩。", true);
      } else if (missionAttempt?.completed) {
        setStatus("任务完成");
        addLog("Python 程序执行完成，任务目标已达成。", true);
      } else if (!stopRequested) {
        setStatus("运行完成");
        addLog("Python 程序执行完成。", true);
      }
    }
  } catch (error) {
    programFailed = true;
    if (currentRunToken === runToken && (!stopRequested || missionCompletionStopRequested)) {
      if (target === "sim") recordCompetitionEvent("program_error", { message: formatPythonError(error) });
      setStatus(target === "real"
        ? "真实小车程序已停止"
        : missionCompletionStopRequested ? "任务完成，但后续代码有误" : "代码出错");
      addLog(`Python 代码出错：${formatPythonError(error)}`);
      markErrorLine(error);
      showPythonFeedback("Python 代码有问题", formatPythonError(error));
    }
  } finally {
    if (currentRunToken === runToken) {
      if (target === "real" && !stopRequested) {
        const stopSent = await sendRealRobotStop(runContext?.robotBaseUrl || robotBaseUrl);
        setRealStopHazard(!stopSent);
        if (!stopSent) setStatus("停止指令未确认，请立即现场检查小车");
      }
      running = false;
      if (competitionTeamIdInput) competitionTeamIdInput.disabled = managedFiveRunIsOpen();
      realtimeRun = null;
      if (target === "sim") {
        finishCompetitionRun(missionAttempt?.completed ? "completed" : programFailed ? "program_error" : stopRequested ? "stopped" : "program_finished");
      }
      updateRealRobotControls();
    }
  }
}

function setStatus(message) {
  const text = String(message || "").trim();
  if (!appStatusToast || !text) return;

  const generation = ++appStatusToastGeneration;
  if (appStatusToastTimeoutId) clearTimeout(appStatusToastTimeoutId);
  appStatusToast.textContent = text;
  appStatusToast.dataset.tone = /失败|错误|中断|受阻|过期/.test(text)
    ? "error"
    : /请先|尚未|没有|取消|未抓到|还在准备/.test(text)
      ? "warning"
      : "info";
  appStatusToast.hidden = false;
  appStatusToast.classList.add("is-visible");

  appStatusToastTimeoutId = setTimeout(() => {
    if (generation !== appStatusToastGeneration) return;
    appStatusToast.classList.remove("is-visible");
    appStatusToastTimeoutId = setTimeout(() => {
      if (generation === appStatusToastGeneration) appStatusToast.hidden = true;
    }, 180);
  }, 2800);
}

function initializeSimulationVision() {
  void startVirtualCameraVision().catch(error => {
    latestVirtualCameraFrameId = null;
    addLog(`虚拟车载摄像头暂不可用：${error.message || error}`);
  });
  updateDistance();
  updateRobotState();
  renderMissionProgress();
  setCompetitionHudVisibility();
  markSceneShadowDirty();
  resizeRenderer();
}

function isSimulatorUiTarget(target) {
  return Boolean(target?.closest?.(
    "button, input, select, textarea, option, a, label, [role='button'], [role='link'], [role='menu'], .competition-hud, .mission-card, .training-vision-workbench, .camera-view, .sensor-card"
  ));
}

function placeObjectFromClick(event) {
  if (isSimulatorUiTarget(event.target)) return;
  if (!placeMode) return;
  if (isOrbitDragging) return;
  if (isCompetitionMission()) {
    setStatus("正式赛题地图已锁定");
    return;
  }
  if (running) {
    setStatus("请先停止程序再编辑地图");
    return;
  }
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
  const placementBounds = currentPlayableBounds(1);
  if (x < placementBounds.minX || x > placementBounds.maxX || z < placementBounds.minZ || z > placementBounds.maxZ) return;

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
    addLog("这里已有墙体、货架或固定场景模型，请换一个格子放置。");
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
      return;
    }
    activeMission.obstacles.push([x, z]);
  }
  if (placeMode === "package") {
    const packages = ensureMissionPackages();
    if (packages.length >= MAX_SAVED_PACKAGES) {
      setStatus("包裹数量已达上限");
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
  const size = MAZE_CELL_SIZE * 0.92;
  const wall = [x, z, size, size];
  activeMission.walls = Array.isArray(activeMission.walls) ? activeMission.walls : [];
  if (activeMission.walls.length >= MAX_SAVED_WALLS) {
    setStatus("墙体数量已达上限");
    return;
  }
  const protectedRoute = createMazeSolutionPath(MAZE_LAYOUT);
  const blocksRoute = protectedRoute.some(([routeX, routeZ]) =>
    circleHitsRect(routeX, routeZ, ROBOT_RADIUS + 0.08, { x, z, w: size, h: size })
  );
  if (blocksRoute) {
    setStatus("这里是迷宫通行路线");
    addLog("不能在迷宫必经通道上放置木板墙，否则导航点或出口会无法到达。");
    return;
  }
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
  const packageIndex = packages.reduce((matchedIndex, record, index) => (
    Math.hypot(record.x - x, record.z - z) <= 0.55 ? index : matchedIndex
  ), -1);
  if (packageIndex >= 0) {
    packages.splice(packageIndex, 1);
  }
  if (activeMission.goal && Math.hypot(activeMission.goal[0] - x, activeMission.goal[1] - z) <= 0.55) {
    activeMission.goal = null;
  }
  commitMissionEdit();
  if (activeMission.obstacles.length !== before) {
    addLog(`已删除 (${x}, ${z}) 附近的障碍。`);
  } else if ((activeMission.walls || []).length !== beforeWalls) {
    addLog(`已删除 (${x}, ${z}) 附近的迷宫墙。`);
  } else if (packageIndex >= 0) {
    addLog(`已删除 (${x}, ${z}) 这一堆最上层的包裹。`);
  } else {
    addLog(`已尝试删除 (${x}, ${z}) 附近物体。`);
  }
}

function createMapPayload(name) {
  const sourceMission = structuredClone(missionBaseline || activeMission);
  const packages = normalizePackageRecords(sourceMission).map(record => ({ id: record.id, x: record.x, z: record.z }));
  return {
    id: globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `map-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    obstacles: (sourceMission.obstacles || []).map(([x, z]) => [x, z]),
    walls: Array.isArray(sourceMission.walls) ? sourceMission.walls.map(([x, z, w, h]) => [x, z, w, h]) : [],
    packages,
    package: packages[0] ? [packages[0].x, packages[0].z] : null,
    goal: sourceMission.goal ? [...sourceMission.goal] : null,
    theme: sourceMission.theme || null,
    environment: sourceMission.environment || (sourceMission.theme === "maze" ? "maze" : "sandbox"),
    packageVisual: sourceMission.packageVisual === "ball" ? "ball" : "box",
    mapSize: finiteNumber(sourceMission.mapSize, sourceMission.theme === "maze" ? MAZE_MAP_SIZE : MAP_SIZE),
    wallHeight: finiteNumber(sourceMission.wallHeight, sourceMission.theme === "maze" ? 1.08 : 0.82),
    completion: structuredClone(sourceMission.completion || { type: "auto" }),
    start: Array.isArray(sourceMission.start) ? [...sourceMission.start] : null,
    guidePath: Array.isArray(sourceMission.guidePath) ? sourceMission.guidePath.map(([x, z]) => [x, z]) : [],
    title: sourceMission.title,
    text: sourceMission.text,
    mapStyle: currentMapStyle,
    updatedAt: Date.now()
  };
}

const MAP_STORAGE_KEY = "chenlongPythonMaps";
const LEGACY_MAP_STORAGE_KEYS = ["chenlongBlocklyMaps", "chenlongBlocklyMap"];

function migrateSavedMapStorage() {
  if (localStorage.getItem(MAP_STORAGE_KEY)) return;
  const legacyMaps = localStorage.getItem(LEGACY_MAP_STORAGE_KEYS[0]);
  if (legacyMaps) localStorage.setItem(MAP_STORAGE_KEY, legacyMaps);
}

function getSavedMaps() {
  try {
    const maps = JSON.parse(localStorage.getItem(MAP_STORAGE_KEY) || "[]");
    return Array.isArray(maps) ? maps.filter(map => map && map.id && map.name) : [];
  } catch {
    return [];
  }
}

function setSavedMaps(maps) {
  localStorage.setItem(MAP_STORAGE_KEY, JSON.stringify(maps));
}

function migrateLegacyMapSave() {
  const legacy = localStorage.getItem(LEGACY_MAP_STORAGE_KEYS[1]);
  if (!legacy || getSavedMaps().length) return;
  try {
    const payload = JSON.parse(legacy);
    const normalized = normalizeSavedMissionPayload(payload);
    const map = {
      ...createMapPayload("旧版保存地图"),
      obstacles: normalized.obstacles,
      walls: normalized.walls,
      packages: normalized.packages,
      package: normalized.packages[0] ? [normalized.packages[0].x, normalized.packages[0].z] : null,
      goal: normalized.goal,
      theme: payload.theme || null,
      environment: payload.environment || "sandbox",
      packageVisual: payload.packageVisual || (Array.isArray(payload.packages) ? "box" : "ball"),
      mapSize: normalized.mapSize,
      wallHeight: normalized.wallHeight,
      completion: normalized.completion,
      start: normalized.start,
      guidePath: normalized.guidePath,
      title: payload.title || "任务：自定义地图",
      text: payload.text || "从保存的地图继续练习。",
      mapStyle: payload.mapStyle || currentMapStyle
    };
    setSavedMaps([map]);
  } catch {
    localStorage.removeItem(LEGACY_MAP_STORAGE_KEYS[1]);
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
    nameButton.addEventListener("click", () => {
      selectedSavedMapId = map.id;
      loadSelectedMap();
      closeSavedMapMenu();
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

function applyMapPayload(payload) {
  if (running && realtimeRun?.target === "real") {
    setStatus("请先停止真实小车再载入地图");
    addLog("为防止实车失控，运行期间不能载入地图。请先点击“停止”。", true);
    return;
  }
  clearTrainingVisionWorkbench("正在切换训练场景（识别练习）…");
  stopCompetitionReplay();
  if (running) {
    runToken++;
    stopRequested = true;
    pauseRequested = false;
    running = false;
    cancelPythonCollection();
  }
  const normalized = normalizeSavedMissionPayload(payload || {});
  const packageVisual = payload?.packageVisual === "ball" || payload?.environment === "vision"
    ? "ball"
    : payload?.packageVisual === "box" || Array.isArray(payload?.packages) ? "box" : "ball";
  activeMission = {
    title: payload?.title || "任务：自定义地图",
    text: payload?.text || "使用地图编辑器保存的练习场景。",
    theme: payload?.theme || null,
    environment: payload?.environment || "sandbox",
    packageVisual,
    ...normalized
  };
  missionAttempt = null;
  renderMissionInfo();
  captureMissionBaseline();
  if (payload.mapStyle && mapStyleSelect) {
    mapStyleSelect.value = payload.mapStyle;
    setMapStyle(payload.mapStyle, false);
  } else {
    setMapStyle(currentMapStyle, false);
  }
  resetRobot();
  rebuildSceneObjects();
  initializeMissionAttempt();
  setCameraMode(cameraMode === "free" ? "iso" : cameraMode);
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

function loadSelectedMap() {
  const maps = getSavedMaps();
  const map = maps.find(item => item.id === selectedSavedMapId);
  if (!map) {
    renderSavedMapSelect();
    return;
  }
  applyMapPayload(map);
  renderSavedMapSelect(map.id);
  setStatus("地图已载入");
  addLog(`已载入地图“${map.name}”。`);
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
    const active = button.dataset.view === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
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
  updateGuangyangReliefVisibility();
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
  if (isSimulatorUiTarget(event.target)) return;
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
  updateGuangyangReliefVisibility();
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.remove("is-active");
    button.setAttribute("aria-pressed", "false");
  });
  isOrbitDragging = false;
  orbitPointerId = event.pointerId;
  simulator.setPointerCapture?.(event.pointerId);
  lastPointer = { x: event.clientX, y: event.clientY };
}

function orbitDrag(event) {
  if (placeMode || event.pointerId !== orbitPointerId || cameraMode !== "free") return;
  if (event.pointerType === "mouse" && event.buttons !== 1) return;
  const dx = event.clientX - lastPointer.x;
  const dy = event.clientY - lastPointer.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) isOrbitDragging = true;
  orbitYaw -= dx * 0.008;
  orbitPitch = Math.max(0.25, Math.min(1.32, orbitPitch + dy * 0.005));
  lastPointer = { x: event.clientX, y: event.clientY };
  updateFreeCamera();
}

function endOrbitDrag(event) {
  if (event?.pointerId !== undefined && orbitPointerId !== null && event.pointerId !== orbitPointerId) return;
  if (event?.pointerId !== undefined && simulator.hasPointerCapture?.(event.pointerId)) {
    simulator.releasePointerCapture(event.pointerId);
  }
  orbitPointerId = null;
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
    if (cameraMode === "iso") fitIsoCameraToMap();
  }
}

function defaultRightPanelWidth() {
  const gridWidth = workspaceGrid?.getBoundingClientRect?.().width || window.innerWidth || 1200;
  return gridWidth * 0.6;
}

function setRightPanelWidth(width, persist = true) {
  if (window.matchMedia("(max-width: 960px)").matches) {
    workspaceGrid.style.removeProperty("--right-panel-width");
    resizeRenderer();
    return;
  }
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
  else setRightPanelWidth(defaultRightPanelWidth(), false);
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
  workspaceSplitter.addEventListener("dblclick", () => setRightPanelWidth(defaultRightPanelWidth()));
}

function setStatePanelHeight(height, persist = true) {
  if (window.matchMedia("(max-width: 960px)").matches) {
    sidePanel.style.removeProperty("--state-panel-height");
    resizeRenderer();
    return;
  }
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
  } else setStatePanelHeight(220, false);
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
  lastRenderAt = Number.isFinite(lastRenderAt) ? timestamp - (elapsedSinceRender % interval) : timestamp;
  const sceneElapsedMs = simulationSceneElapsedMs();
  animateSceneEffects((sceneElapsedMs ?? timestamp) * 0.001, sceneElapsedMs);
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

function animateSceneEffects(time, simulationElapsedMs = null) {
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
  const lightElapsedMs = simulationElapsedMs ?? (competitionSession?.status === "running"
    ? competitionSession.elapsedMs()
    : performance.now());
  competitionTrafficLightVisuals.forEach(visual => {
    const activeState = globalThis.CompetitionCore?.trafficLightState(visual.config, lightElapsedMs) || "red";
    Object.entries(visual.lamps).forEach(([state, lamp]) => {
      const active = state === activeState;
      lamp.material.emissiveIntensity = active ? 2.2 : 0.05;
      lamp.material.opacity = active ? 1 : 0.32;
      lamp.material.transparent = !active;
    });
  });
  if (competitionSession?.status === "running") renderCompetitionHud();
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
    drawingBuffer: { width: renderer?.domElement?.width || 0, height: renderer?.domElement?.height || 0 },
    render: {
      calls: fpsTarget > 0 ? info?.render?.calls || 0 : 0,
      triangles: fpsTarget > 0 ? info?.render?.triangles || 0 : 0,
      points: fpsTarget > 0 ? info?.render?.points || 0 : 0
    },
    memory: { geometries: info?.memory?.geometries || 0, textures: info?.memory?.textures || 0 },
    sceneObjects: scene?.children?.length || 0,
    collisionShapes: robotCollisionShapes.length,
    trajectoryPoints: trajectoryPoints.length,
    // Keep the old internal-unit field for compatibility, and expose the
    // calibrated value explicitly so diagnostics cannot mistake it for cm.
    trajectoryDistance: Math.round(trajectoryTotalDistance * 100) / 100,
    trajectoryWorldUnits: Math.round(trajectoryTotalDistance * 100) / 100,
    trajectoryDistanceCm: Math.round(worldUnitsToCm(trajectoryTotalDistance) * 100) / 100
  };
}

window.getRobotLabPerformance = getRobotLabPerformance;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitWhilePaused() {
  const pendingId = pauseRequested ? pendingPythonRun?.id : null;
  if (pendingId !== null && pendingId !== undefined) {
    clearTimeout(pendingPythonRun.timer);
    pendingPythonRun.timer = null;
  }
  while (pauseRequested && !stopRequested) {
    await sleep(80);
  }
  if (!stopRequested && pendingPythonRun?.id === pendingId) {
    refreshPythonWatchdog(pendingPythonRun.watchdogTimeout || 5000);
  }
}

try {
  robotBaseUrlInput.value = localStorage.getItem("chenlongRobotBaseUrl") || robotBaseUrlInput.value;
  realStopHazard = localStorage.getItem("chenlongRealStopHazard") === "1";
} catch {}
if (targetSelect) targetSelect.value = "sim";
initScene();
setRunTarget("sim", { announce: false });
window.addEventListener("beforeunload", event => {
  competitionSessionAbortController?.abort();
  serverVerificationAbortController?.abort();
  persistCompetitionBatchRecovery();
  if (rankedEvaluationLocksWorkspace() || competitionBatchIsOpen()
    || competitionBatchOperation || competitionSubmissionOperation
    || pendingCompetitionDraftSaveOperations.size > 0) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", event => {
  if (targetSelect?.value === "real") {
    const baseUrl = realtimeRun?.robotBaseUrl || null;
    void stopRealCameraPreview({ keepalive: true, message: "页面已关闭，摄像头已释放" });
    stopRequested = true;
    pauseRequested = false;
    robotLinearSpeed = 0;
    robotSteering = 0;
    if (running || pendingPythonRun) {
      cancelPythonCollection("page_hidden");
      running = false;
      updateRealRobotControls();
    }
    void sendRealRobotStop(baseUrl).then(sent => setRealStopHazard(!sent));
  }
  if (!event.persisted) {
    disposeVirtualCamera();
    competitionBatchAbortController?.abort();
    rankedEvaluationAbortController?.abort();
    competitionSubmissionAbortController?.abort();
  }
});
document.addEventListener("visibilitychange", () => {
  if (targetSelect?.value !== "real") return;
  if (!document.hidden) {
    startRealCameraPreview();
    return;
  }
  void stopRealCameraPreview({ keepalive: true, message: "页面在后台，摄像头预览已暂停" });
  const baseUrl = realtimeRun?.robotBaseUrl || null;
  if (running) {
    stopRequested = true;
    pauseRequested = false;
    robotLinearSpeed = 0;
    robotSteering = 0;
    cancelPythonCollection("page_hidden");
    running = false;
    updateRealRobotControls();
  }
  void sendRealRobotStop(baseUrl).then(sent => {
    setRealStopHazard(!sent);
    if (!sent) setStatus("页面切到后台且停止未确认，请现场检查小车");
  });
});
initMissionCardToggle();
initCompetitionHudToggle();
initWorkspaceSplitter();
initStateSceneSplitter();
migrateSavedMapStorage();
migrateLegacyMapSave();
renderSavedMapSelect();
void globalThis.chenlongAuthReady?.then(async user => {
  if (competitionTeamName) competitionTeamName.textContent = user.teamName || user.username || "未填写";
  if (competitionTeamIdInput) competitionTeamIdInput.value = user.id;
  try {
    await refreshPublishedGuangyangMap({ apply: true, announce: false });
  } catch (error) {
    addLog(`管理员地图暂未更新：${String(error?.message || error).slice(0, 100)}；当前使用内置地图。`);
  }
});
initializeSimulationVision();
loadPythonRuntime();
resetCompetitionVerificationResult();
resetCompetitionSubmissionState({ clearSession: true });
probeVerificationService();

document.querySelector("#runButton").addEventListener("click", runProgram);
targetSelect?.addEventListener("change", event => setRunTarget(event.target.value));
applyRobotIpButton?.addEventListener("click", applyRobotIp);
retryCameraButton?.addEventListener("click", () => void restartRealCameraPreview());
robotBaseUrlInput?.addEventListener("change", applyRobotIp);
robotBaseUrlInput?.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  applyRobotIp();
});
startRankedEvaluationButton?.addEventListener("click", openRankedEvaluationConfirmation);
recoverRankedEvaluationButton?.addEventListener("click", recoverOrContinueRankedEvaluation);
stopRankedEvaluationButton?.addEventListener("click", requestStopRankedEvaluation);
cancelRankedEvaluationButton?.addEventListener("click", closeRankedEvaluationConfirmation);
confirmRankedEvaluationButton?.addEventListener("click", createConfirmedRankedEvaluation);
rankedEvaluationConfirmDialog?.addEventListener("cancel", event => {
  event.preventDefault();
  closeRankedEvaluationConfirmation();
});
rankedEvaluationConfirmDialog?.addEventListener("click", event => {
  if (event.target === rankedEvaluationConfirmDialog) closeRankedEvaluationConfirmation();
});
startCompetitionBatchButton?.addEventListener("click", startOrContinueCompetitionBatch);
stopCompetitionBatchButton?.addEventListener("click", requestStopCompetitionBatch);
competitionBatchRecoveryItems?.addEventListener("click", event => {
  const button = event.target.closest("button[data-candidate-index][data-action]");
  if (!button || !competitionBatchRecoveryItems.contains(button)) return;
  const candidateIndex = Number(button.dataset.candidateIndex);
  if (!Number.isSafeInteger(candidateIndex)
    || candidateIndex < 0 || candidateIndex >= COMPETITION_BATCH_DISCOVERY_LIMIT) return;
  if (button.dataset.action === "recover") recoverDiscoveredCompetitionBatch(candidateIndex);
  else if (button.dataset.action === "close") closeDiscoveredCompetitionBatch(candidateIndex);
});
document.querySelector("#stopButton").addEventListener("click", async () => {
  const real = realtimeRun?.target === "real" || targetSelect?.value === "real";
  if (real) {
    const baseUrl = realtimeRun?.robotBaseUrl || null;
    const wasRunning = running;
    stopCompetitionReplay();
    if (wasRunning) {
      stopRequested = true;
      pauseRequested = false;
      robotLinearSpeed = 0;
      robotSteering = 0;
      cancelPythonCollection("stopped");
      running = false;
    }
    const sent = await sendRealRobotStop(baseUrl);
    setRealStopHazard(!sent);
    setStatus(sent
      ? "真实小车停止指令已发送（设备未回传确认）"
      : "停止指令未确认，请立即现场检查小车");
    if (wasRunning) addLog("已停止当前真实小车 Python 程序。", true);
    updateRealRobotControls();
    return;
  }
  if (rankedEvaluationIsOpen()) {
    setStatus("筛选五局进行中，请使用筛选面板中的结束按钮");
    return;
  }
  if (replayRunning || replayRecordLoading || archivedReplayLoadPromise || replayRecordLoadOperation) {
    const wasLoadingArchive = replayRecordLoading || archivedReplayLoadPromise || replayRecordLoadOperation;
    stopCompetitionReplay();
    if (wasLoadingArchive) setStatus("已取消后台存档载入");
    return;
  }
  if (running) {
    competitionSessionAbortController?.abort();
    recordCompetitionManualInput("stop", { control: "stop_button" });
    if (competitionSession?.status === "timeout") {
      handleCompetitionTimeout(competitionSession.finalRecord);
      return;
    }
    stopRequested = true;
    pauseRequested = false;
    robotLinearSpeed = 0;
    robotSteering = 0;
    competitionTick(true);
    const stoppedRecord = cancelPythonCollection("stopped");
    if (stoppedRecord?.result?.reason !== "completed") {
      setStatus("已停止");
      addLog("已停止当前 Python 程序。");
    }
    return;
  }
  setStatus("当前没有运行程序");
});
document.querySelector("#resetButton").addEventListener("click", async () => {
  if (rankedEvaluationIsOpen()) {
    setStatus("筛选五局进行中，不能手动重置当前局");
    return;
  }
  const real = realtimeRun?.target === "real" || targetSelect?.value === "real";
  if (real) {
    const baseUrl = realtimeRun?.robotBaseUrl || null;
    runToken++;
    stopRequested = true;
    pauseRequested = false;
    robotLinearSpeed = 0;
    robotSteering = 0;
    clearActionLog();
    if (pendingPythonRun) cancelPythonCollection("reset");
    else realtimeRun = null;
    running = false;
    const sent = await sendRealRobotStop(baseUrl);
    setRealStopHazard(!sent);
    setStatus(sent
      ? "真实小车程序已重置，停止指令已发送（未回传确认）"
      : "重置后停止仍未确认，请立即现场检查小车");
    updateRobotTelemetry(undefined, true);
    updateRealRobotControls();
    return;
  }
  competitionSessionAbortController?.abort();
  stopCompetitionReplay();
  if (competitionSession?.status === "running") {
    recordCompetitionManualInput("reset", { control: "reset_button" });
    if (competitionSession.status === "timeout") {
      handleCompetitionTimeout(competitionSession.finalRecord);
    }
    robotLinearSpeed = 0;
    robotSteering = 0;
    competitionTick(true);
  }
  runToken++;
  stopRequested = true;
  cancelPythonCollection("reset");
  pauseRequested = false;
  running = false;
  missionAttempt = null;
  restoreMissionBaseline();
  resetRobot();
  rebuildSceneObjects();
  initializeMissionAttempt();
  if (isCompetitionMission() && latestCompetitionRecord) {
    renderCompetitionHud(latestCompetitionRecord.result, true);
    setCompetitionRunState("上一局结果", "previous");
  }
  setCameraMode(cameraMode === "free" ? "iso" : cameraMode);
  if (!missionAttempt?.completed) setStatus("已重置");
  clearActionLog();
  addLog("小车已回到起点。");
});
exportRunRecordButton?.addEventListener("click", exportLatestCompetitionRecord);
replayRunRecordButton?.addEventListener("click", replayLatestCompetitionRecord);
verifyRunRecordButton?.addEventListener("click", verifyLatestCompetitionRecordOnServer);
submitRunRecordButton?.addEventListener("click", submitLatestCompetitionRecord);
recordsNavLink?.addEventListener("click", openCompetitionRecords);
closeCompetitionRecordsButton?.addEventListener("click", closeCompetitionRecords);
submitPendingRunRecordButton?.addEventListener("click", submitPendingCompetitionRecord);
refreshCompetitionRecordsButton?.addEventListener("click", loadCompetitionRecordsPreview);
competitionRecordsDialog?.addEventListener("cancel", event => {
  event.preventDefault();
  closeCompetitionRecords();
});
competitionRecordsDialog?.addEventListener("click", event => {
  if (event.target === competitionRecordsDialog) closeCompetitionRecords();
});
function persistPythonDraft() {
  if (!pythonEditor) return;
  try {
    const source = pythonEditor.value.slice(0, MAX_PYTHON_DRAFT_LENGTH);
    sessionStorage.setItem(PYTHON_DRAFT_STORAGE_KEY, source);
  } catch (_error) {
    // 浏览器禁用会话存储时仍保持编辑器可用。
  }
}

function restorePythonDraft() {
  if (!pythonEditor) return;
  try {
    const source = sessionStorage.getItem(PYTHON_DRAFT_STORAGE_KEY);
    if (typeof source === "string") pythonEditor.value = source;
  } catch (_error) {
    // 浏览器禁用会话存储时沿用页面内置示例。
  }
}

function closeExampleMenu() {
  if (!exampleDropdown || !loadExampleButton) return;
  exampleDropdown.hidden = true;
  loadExampleButton.setAttribute("aria-expanded", "false");
}

function loadExample(exampleId, sceneKey = "", trainingMode = "", aiAutonomy = false) {
  if (running && realtimeRun?.target === "real") {
    setStatus("请先停止真实小车再载入示例");
    closeExampleMenu();
    return;
  }
  if (managedFiveRunIsOpen() || rankedEvaluationLocksWorkspace()) {
    setStatus(rankedEvaluationLocksWorkspace()
      ? "筛选五局进行中，源码已锁定，不能载入其他示例"
      : "练习五局进行中（不入榜），源码已锁定，不能载入其他示例");
    return;
  }
  const source = EXAMPLE_PROGRAMS[exampleId];
  if (!source) return;
  if (trainingMode) {
    enterGuangyangTrainingMode(trainingMode);
  } else if (sceneKey && missions[sceneKey]) {
    if (sceneKey === "guangyang") setGuangyangAiAutonomyMode(aiAutonomy);
    const sceneSelect = document.querySelector("#sceneSelect");
    if (sceneSelect) sceneSelect.value = sceneKey;
    loadMission(sceneKey);
  }
  pythonEditor.value = source;
  hidePythonFeedback();
  clearErrorLine();
  updateLineNumbers();
  persistPythonDraft();
  pythonEditor.focus();
  closeExampleMenu();
}

loadExampleButton.addEventListener("click", () => {
  if (!exampleDropdown) return;
  const opening = exampleDropdown.hidden;
  exampleDropdown.hidden = !opening;
  loadExampleButton.setAttribute("aria-expanded", String(opening));
});
exampleDropdown?.addEventListener("click", event => {
  const item = event.target.closest("button[data-example]");
  if (item) loadExample(item.dataset.example, item.dataset.scene, item.dataset.trainingMode,
    item.dataset.aiAutonomy === "true");
});
document.addEventListener("click", event => {
  if (exampleMenu && !exampleMenu.contains(event.target)) closeExampleMenu();
});
pythonEditor.addEventListener("input", () => {
  const managedSource = rankedEvaluationLocksWorkspace()
    ? activeRankedEvaluation?.source || rankedEvaluationInterruptedCreate?.source
    : competitionBatchIsOpen() ? activeCompetitionBatch?.source : null;
  if (managedSource && pythonEditor.value.trim() !== managedSource) {
    pythonEditor.value = managedSource;
    setStatus(rankedEvaluationLocksWorkspace()
      ? "筛选五局进行中，源码已锁定"
      : "练习五局进行中（不入榜），源码已锁定");
  }
  hidePythonFeedback();
  clearErrorLine();
  updateLineNumbers();
  persistPythonDraft();
  refreshCompetitionBatchDiscoveryDraftMatch();
});
pythonEditor.addEventListener("scroll", () => {
  lineNumbers.scrollTop = pythonEditor.scrollTop;
  syncPythonHighlightScroll();
});
pythonEditor.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runProgram();
    return;
  }
  const start = pythonEditor.selectionStart;
  const end = pythonEditor.selectionEnd;
  const value = pythonEditor.value;
  const indent = "    ";
  if (event.key === "Tab") {
    event.preventDefault();
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = value.indexOf("\n", end);
    const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
    if (start !== end) {
      const selectedLines = value.slice(lineStart, lineEnd);
      const changedLines = event.shiftKey
        ? selectedLines.replace(/^ {1,4}/gm, "")
        : selectedLines.replace(/^/gm, indent);
      pythonEditor.value = `${value.slice(0, lineStart)}${changedLines}${value.slice(lineEnd)}`;
      pythonEditor.selectionStart = lineStart;
      pythonEditor.selectionEnd = lineStart + changedLines.length;
    } else if (event.shiftKey) {
      const leading = value.slice(lineStart).match(/^ {1,4}/)?.[0] || "";
      pythonEditor.value = `${value.slice(0, lineStart)}${value.slice(lineStart + leading.length)}`;
      const cursor = Math.max(lineStart, start - leading.length);
      pythonEditor.selectionStart = pythonEditor.selectionEnd = cursor;
    } else {
      pythonEditor.value = `${value.slice(0, start)}${indent}${value.slice(end)}`;
      pythonEditor.selectionStart = pythonEditor.selectionEnd = start + indent.length;
    }
    pythonEditor.dispatchEvent(new Event("input"));
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const currentLine = value.slice(value.lastIndexOf("\n", start - 1) + 1, start);
    const leading = currentLine.match(/^\s*/)?.[0] || "";
    const nextIndent = currentLine.trimEnd().endsWith(":") ? `${leading}${indent}` : leading;
    pythonEditor.value = `${value.slice(0, start)}\n${nextIndent}${value.slice(end)}`;
    pythonEditor.selectionStart = pythonEditor.selectionEnd = start + nextIndent.length + 1;
    pythonEditor.dispatchEvent(new Event("input"));
    return;
  }
  const pairs = { "(": ")", "[": "]", "{": "}", "\"": "\"", "'": "'" };
  if (pairs[event.key] && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    const selected = value.slice(start, end);
    const close = pairs[event.key];
    pythonEditor.value = `${value.slice(0, start)}${event.key}${selected}${close}${value.slice(end)}`;
    pythonEditor.selectionStart = start + 1;
    pythonEditor.selectionEnd = selected ? end + 1 : start + 1;
    pythonEditor.dispatchEvent(new Event("input"));
    return;
  }
  if (")]}\"'".includes(event.key) && !event.ctrlKey && !event.metaKey && start === end && value[start] === event.key) {
    event.preventDefault();
    pythonEditor.selectionStart = pythonEditor.selectionEnd = start + 1;
  }
});
visionApiHelpButton?.addEventListener("click", () => {
  if (!visionApiHelp) return;
  const opening = visionApiHelp.hidden;
  visionApiHelp.hidden = !opening;
  visionApiHelpButton.setAttribute("aria-expanded", String(opening));
});
document.querySelector("#sceneSelect").addEventListener("change", event => {
  const key = event.target.value;
  loadMission(event.target.value);
  if (isGuangyangMissionKey(key)) {
    const taskId = Object.entries(GUANGYANG_MISSION_KEY_BY_TASK_ID)
      .find(([, missionKey]) => missionKey === key)?.[0];
    void refreshPublishedGuangyangMap({
      config: guangyangConfigForTaskId(taskId),
      apply: true,
      announce: true
    }).catch(error => {
      addLog(`管理员地图更新失败：${String(error?.message || error).slice(0, 100)}。`);
    });
  }
});
guangyangTrainingButton?.addEventListener("click", () => {
  if (isObjectTrainingMission()) exitGuangyangTrainingMode();
  else enterGuangyangTrainingMode("target");
});
exitGuangyangTrainingButton?.addEventListener("click", exitGuangyangTrainingMode);
document.querySelectorAll("[data-guangyang-training]").forEach(button => {
  button.addEventListener("click", () => enterGuangyangTrainingMode(button.dataset.guangyangTraining));
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
  if (activeMission?.environment === "guangyang") {
    setStatus("广阳岛地图已锁定");
    return;
  }
  if (running) {
    setStatus("请先停止程序再清空地图");
    return;
  }
  activeMission.obstacles = [];
  activeMission.walls = [];
  activeMission.packages = [];
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
    setStatus(button.textContent + "：点击地图格子");
  });
});

restorePythonDraft();
updateLineNumbers();
renderCompetitionBatchPanel();
renderRankedEvaluationPanel();
if (FIVE_RUN_EVALUATION_UI_ENABLED) {
  Promise.resolve(globalThis.chenlongAuthReady)
    .then(async () => {
      await restoreRankedEvaluationFromServer();
      if (rankedEvaluationReady && !rankedEvaluationIsOpen()
        && !rankedEvaluationReservationIncomplete) {
        await restoreCompetitionBatchFromPage();
      }
    })
    .catch(() => {});
}

if (window.lucide) {
  window.lucide.createIcons();
}
