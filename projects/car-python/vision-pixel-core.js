(function publishVisionPixelCore(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.CarVisionPixelCore = api;
    if (root.window && root.window !== root) root.window.CarVisionPixelCore = api;
  }
})(typeof globalThis === "object" ? globalThis : this, function createVisionPixelCore() {
  "use strict";

  const WORLD_UNITS_PER_METER = 8;
  const CENTIMETERS_PER_WORLD_UNIT = 100 / WORLD_UNITS_PER_METER;

  const CAMERA_DEFINITION = deepFreeze({
    id: "chenlong.virtual-camera",
    version: "v1",
    source: { width: 640, height: 480, pixelFormat: "rgba8-straight" },
    model: { width: 640, height: 640, pixelFormat: "rgba8-opaque" },
    verticalFovDegrees: 60,
    cameraForwardOffsetMeters: 0.43,
    mountPositionMeters: { x: 0, y: 0.54, z: -0.43 },
    mountPitchDegrees: -8,
    nearMeters: 0.04,
    farMeters: 30,
    letterbox: {
      fit: "contain",
      scale: 1,
      drawWidth: 640,
      drawHeight: 480,
      padX: 0,
      padY: 80,
      background: [0, 0, 0, 255]
    },
    compositing: {
      operator: "source-over",
      sourceAlpha: "straight-unorm8",
      destinationAlpha: 255,
      outputAlpha: 255,
      channelRounding: "Math.round"
    },
    contrast: {
      factor: 1.12,
      pivot: 128,
      channels: ["red", "green", "blue"],
      clamp: [0, 255],
      rounding: "Math.round"
    },
    sharpness: {
      algorithm: "rms-laplacian",
      sampleStep: 4,
      lumaWeights: [0.299, 0.587, 0.114],
      decimalPlaces: 1
    }
  });

  const DETECTOR_DEFINITION = deepFreeze({
    id: "chenlong.virtual-pixel",
    version: "v2",
    input: { width: 640, height: 640, pixelFormat: "rgba8-opaque" },
    source: "virtual-cv",
    sampling: { step: 2, sampleOffset: 1, connectivity: 4 },
    direction: { leftMaxCenterRatio: 0.42, rightMinCenterRatio: 0.58, labels: ["左", "中间", "右"] },
    distance: {
      cameraDefinitionId: "chenlong.virtual-camera/v1",
      focalAxis: "vertical",
      horizontalCorrection: "divide-by-cosine",
      outputClampMeters: [0.05, 8],
      minimumCosine: 0.35
    },
    regionRules: {
      compactObject: { minimumWidth: 12, minimumHeight: 12, minimumBoxArea: 120, ratio: [0.45, 2.2], minimumCoverage: 0.18 },
      regularVerticalSign: { minimumWidth: 8, minimumHeight: 16, minimumBoxArea: 160, maximumWidthRatio: 0.3, maximumHeightRatio: 0.7, ratio: [0.16, 0.9], minimumCoverage: 0.18 },
      clippedVerticalSign: { boundaryTolerance: 4, minimumWidth: 12, minimumHeightRatio: 0.45, maximumWidthRatio: 0.72, minimumBoxArea: 480, ratio: [0.08, 0.9], minimumCoverage: 0.22 },
      brightSeed: { minimumCount: 6, minimumFraction: 0.015 },
      obstacleStripe: { minimumWidth: 12, minimumHeight: 3, maximumWidthRatio: 0.45, ratio: [1.5, 12], minimumCoverage: 0.2 },
      obstacleExpansion: { leftWidthRatio: 0.22, topHeightRatio: 3, widthRatio: 1.44, heightRatio: 5 },
      obstacleDuplicateOverlap: 0.12,
      zoneSuppression: { overlap: 0.03, centerMarginPixels: 8 }
    },
    classes: [
      {
        category: "target", label: "红球", aliases: ["球", "包裹", "目标物", "sports ball"],
        candidateRule: "r>=52 && g<=86 && b<=92 && r-g>=30 && r-b>=26 && r>=g*1.5 && r>=b*1.38",
        seedRule: "r>=100 && g<=92 && b<=96 && r-g>=55 && r-b>=48 && r>=g*1.55 && r>=b*1.45",
        maximumRegions: 3, physicalWidthMeters: 0.44, confidence: { base: 0.72, coverageWeight: 0.22, maximum: 0.97 },
        clearanceOffsetMeters: 0.72, nearDistanceMeters: 1.35, minimumApproachDistanceMeters: 0.725
      },
      {
        category: "distractor", label: "混淆物", aliases: ["干扰物", "诱饵", "distractor"],
        candidateRule: "b>=62 && b-g>=30 && b>=g*1.38 && (b-r>=30 || (r>=48 && b>=r*1.15))",
        seedRule: "b>=135 && b-g>=45 && b>=g*1.45 && (b-r>=42 || (r>=75 && b>=r*1.18))",
        maximumRegions: 3, physicalWidthMeters: 0.44, confidence: { base: 0.7, coverageWeight: 0.22, maximum: 0.96 },
        clearanceOffsetMeters: 0.72, nearDistanceMeters: 1.35, minimumApproachDistanceMeters: 0.725
      },
      {
        category: "storage-zone", label: "存放点", aliases: ["存放区", "放置点", "storage zone"],
        candidateRule: "g>=90 && g-r>=24 && g-b>=16 && g>=r*1.22 && g>=b*1.16",
        maximumRegions: 4, physicalWidthMeters: 0.38, confidence: { base: 0.7, coverageWeight: 0.22, maximum: 0.96 },
        clearanceOffsetMeters: null, nearDistanceMeters: 1.35, minimumApproachDistanceMeters: 1.08
      },
      {
        category: "cleanup-zone", label: "清理点", aliases: ["清理区", "回收点", "cleanup zone"],
        candidateRule: "r>=135 && g>=55 && g<=r*0.82 && b<=105 && r-g>=35 && g-b>=12",
        maximumRegions: 4, physicalWidthMeters: 0.38, confidence: { base: 0.7, coverageWeight: 0.22, maximum: 0.96 },
        clearanceOffsetMeters: null, nearDistanceMeters: 1.35, minimumApproachDistanceMeters: 1.08
      },
      {
        category: "obstacle", label: "障碍物", aliases: ["障碍", "方块", "墙"],
        candidateRule: "r>=125 && g>=100 && b<=105 && g>=r*0.62 && r>=b*1.45 && g>=b*1.2",
        maximumRegions: 6, physicalWidthMeters: 0.46, confidence: { base: 0.68, coverageWeight: 0.24, maximum: 0.95 },
        clearanceOffsetMeters: 0.96, nearClearanceMeters: 0.48
      }
    ],
    output: { distanceEstimated: true, stable: true, attachFrameId: true, attachCapturedAt: true }
  });

  const LEGACY_QUERY_DEFINITION = deepFreeze({
    id: "chenlong.virtual-query",
    version: "v1",
    detectorVersion: "chenlong.virtual-pixel/v2",
    methods: ["sees", "count", "detect", "near", "centered", "direction", "distance_to", "observe"],
    defaultConfidence: 0.6,
    centeredDirection: "中间",
    missingDirection: "未找到",
    categoryLabels: {
      target: "目标物",
      obstacle: "障碍物",
      distractor: "混淆物",
      "storage-zone": "存放点",
      "cleanup-zone": "清理点"
    },
    matchingAliases: {
      ball: ["红球", "球"],
      package: ["包裹", "纸箱", "箱子"],
      obstacle: ["障碍", "障碍物", "方块"]
    },
    obstacleQueryAliases: ["障碍", "障碍物", "方块", "墙", "墙壁", "边界"],
    avoidObstacleClearanceMeters: 0.8,
    output: { confidenceDecimalPlaces: 2, distanceUnit: "centimeter", distanceRounding: "Math.round" }
  });

  const QUERY_DEFINITION = deepFreeze({
    ...clone(LEGACY_QUERY_DEFINITION),
    version: "v2",
    worldUnitsPerMeter: WORLD_UNITS_PER_METER
  });

  // These constants are generated from backend/canonical-json.js and guarded by
  // Node tests. They intentionally do not depend on Web Crypto at runtime.
  const CAMERA_DEFINITION_HASH = "88a9f8cc474d60a60e68fca46cb9e0d0bd5cffc86d1312fa481e8133d4b26600";
  const DETECTOR_DEFINITION_HASH = "f1f0ba40b9177bf93055579eaa0602e369a2bf8daaf522f98df3775df5a5dead";
  const LEGACY_QUERY_DEFINITION_HASH = "a9cf15fca3038d335ef97b04a396e0852e953854471770db1959076b209b1bdd";
  const QUERY_DEFINITION_HASH = "d3313d4d6a3613e72843b876bb159f2b818e5d3587e22fe17d2b5875a8501b55";

  const LEGACY_VISION_DEFINITION = deepFreeze({
    id: "chenlong.virtual-vision",
    version: "v1",
    cameraDefinition: CAMERA_DEFINITION,
    cameraDefinitionHash: CAMERA_DEFINITION_HASH,
    detectorDefinition: DETECTOR_DEFINITION,
    detectorDefinitionHash: DETECTOR_DEFINITION_HASH,
    queryDefinition: LEGACY_QUERY_DEFINITION,
    queryDefinitionHash: LEGACY_QUERY_DEFINITION_HASH
  });
  const LEGACY_VISION_DEFINITION_HASH = "59a09f28e071796a4bbd63a1b750185227ec3ed1a945a9d861957121ce0b20ec";
  const VISION_DEFINITION = deepFreeze({
    id: "chenlong.virtual-vision",
    version: "v2",
    cameraDefinition: CAMERA_DEFINITION,
    cameraDefinitionHash: CAMERA_DEFINITION_HASH,
    detectorDefinition: DETECTOR_DEFINITION,
    detectorDefinitionHash: DETECTOR_DEFINITION_HASH,
    queryDefinition: QUERY_DEFINITION,
    queryDefinitionHash: QUERY_DEFINITION_HASH
  });
  const VISION_DEFINITION_HASH = "d62b9652e185e544fd12a156527397cc09223cb809b922a0d0d28aed63ce5f05";

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.getOwnPropertyNames(value).forEach(key => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
  }

  function asSourceRgba(value) {
    const input = value && typeof value === "object" && value.rgba !== undefined ? value.rgba : value;
    let bytes;
    if (input instanceof Uint8ClampedArray) bytes = input;
    else if (input instanceof Uint8Array) bytes = input;
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else throw new TypeError("virtual camera input must be a 640x480 RGBA byte array");
    const expected = CAMERA_DEFINITION.source.width * CAMERA_DEFINITION.source.height * 4;
    if (bytes.byteLength !== expected) throw new RangeError(`virtual camera input must contain exactly ${expected} RGBA bytes`);
    return bytes;
  }

  function contrastByte(value) {
    const { factor, pivot } = CAMERA_DEFINITION.contrast;
    return Math.round(clamp((value - pivot) * factor + pivot, 0, 255));
  }

  function calculateSharpness(rgba) {
    const modelWidth = CAMERA_DEFINITION.model.width;
    const modelHeight = CAMERA_DEFINITION.model.height;
    const step = CAMERA_DEFINITION.sharpness.sampleStep;
    const width = Math.floor(modelWidth / step);
    const height = Math.floor(modelHeight / step);
    const gray = new Float32Array(width * height);
    const [redWeight, greenWeight, blueWeight] = CAMERA_DEFINITION.sharpness.lumaWeights;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = ((y * step) * modelWidth + x * step) * 4;
        gray[y * width + x] = rgba[offset] * redWeight + rgba[offset + 1] * greenWeight + rgba[offset + 2] * blueWeight;
      }
    }
    let total = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        const laplacian = gray[index] * 4 - gray[index - 1] - gray[index + 1] - gray[index - width] - gray[index + width];
        total += laplacian * laplacian;
        count += 1;
      }
    }
    return Math.round(Math.sqrt(total / Math.max(1, count)) * 10) / 10;
  }

  function prepareVirtualFrame(input, metadata = {}) {
    const source = asSourceRgba(input);
    const sourceWidth = CAMERA_DEFINITION.source.width;
    const sourceHeight = CAMERA_DEFINITION.source.height;
    const modelWidth = CAMERA_DEFINITION.model.width;
    const modelHeight = CAMERA_DEFINITION.model.height;
    const { padX, padY } = CAMERA_DEFINITION.letterbox;
    const rgba = new Uint8ClampedArray(modelWidth * modelHeight * 4);
    for (let modelPixel = 0; modelPixel < modelWidth * modelHeight; modelPixel += 1) rgba[modelPixel * 4 + 3] = 255;
    for (let y = 0; y < sourceHeight; y += 1) {
      const sourceRow = y * sourceWidth;
      const targetRow = (y + padY) * modelWidth + padX;
      for (let x = 0; x < sourceWidth; x += 1) {
        const sourceOffset = (sourceRow + x) * 4;
        const targetOffset = (targetRow + x) * 4;
        const alpha = source[sourceOffset + 3] / 255;
        rgba[targetOffset] = contrastByte(Math.round(source[sourceOffset] * alpha));
        rgba[targetOffset + 1] = contrastByte(Math.round(source[sourceOffset + 1] * alpha));
        rgba[targetOffset + 2] = contrastByte(Math.round(source[sourceOffset + 2] * alpha));
      }
    }
    const frame = {
      input: null,
      rgba,
      imageData: { width: modelWidth, height: modelHeight, data: rgba },
      cameraDefinitionHash: CAMERA_DEFINITION_HASH,
      scale: CAMERA_DEFINITION.letterbox.scale,
      padX,
      padY,
      sourceWidth,
      sourceHeight,
      sharpness: calculateSharpness(rgba)
    };
    if (metadata.frameId !== undefined) frame.frameId = metadata.frameId;
    if (metadata.capturedAt !== undefined) frame.capturedAt = metadata.capturedAt;
    return frame;
  }

  function overlap(a, b) {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    return intersection / Math.max(1, a.w * a.h + b.w * b.h - intersection);
  }

  function boxesOverlap(a, b) {
    return overlap(
      { x: a.x, y: a.y, w: a.width === undefined ? a.w : a.width, h: a.height === undefined ? a.h : a.height },
      { x: b.x, y: b.y, w: b.width === undefined ? b.w : b.width, h: b.height === undefined ? b.h : b.height }
    );
  }

  function directionForBox(box) {
    const width = box.w === undefined ? box.width : box.w;
    const center = box.x + width / 2;
    return center < CAMERA_DEFINITION.model.width * DETECTOR_DEFINITION.direction.leftMaxCenterRatio
      ? "左"
      : center > CAMERA_DEFINITION.model.width * DETECTOR_DEFINITION.direction.rightMinCenterRatio ? "右" : "中间";
  }

  // 前提：letterbox.scale === 1 且 letterbox.padX === 0。
  // 焦距按 source 像素计算，光心按 model 像素计算；当前配置下两者等价。
  // 若 letterbox 配置变更，本函数会静默给出错误方位角。
  function bearingDegForBox(box) {
    const width = box && (box.w === undefined ? box.width : box.w);
    const x = Number(box && box.x);
    if (!Number.isFinite(x) || !Number.isFinite(Number(width))) return null;
    const center = x + Number(width) / 2;
    const focalPixels = (CAMERA_DEFINITION.source.height / 2)
      / Math.tan(CAMERA_DEFINITION.verticalFovDegrees * Math.PI / 360);
    const opticalCenterX = CAMERA_DEFINITION.letterbox.padX
      + CAMERA_DEFINITION.source.width * CAMERA_DEFINITION.letterbox.scale / 2;
    return Math.atan2(center - opticalCenterX, focalPixels) * 180 / Math.PI;
  }

  function normalizeVisionName(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeCategory(value) {
    const raw = String(value === null || value === undefined ? "" : value).trim();
    const normalized = raw.toLowerCase().replaceAll("_", "-");
    if (Object.prototype.hasOwnProperty.call(QUERY_DEFINITION.categoryLabels, normalized)) return normalized;
    for (const [category, label] of Object.entries(QUERY_DEFINITION.categoryLabels)) {
      if (raw === label) return category;
    }
    return null;
  }

  function canonicalCategory(object) {
    const explicit = normalizeCategory(object && object.category);
    if (explicit) return explicit;
    const label = String(object && object.label || "").trim();
    if (["目标物", "红球"].includes(label)) return "target";
    if (["障碍物", "黄黑障碍"].includes(label)) return "obstacle";
    if (["混淆物", "干扰物", "蓝球", "蓝色混淆物"].includes(label)) return "distractor";
    if (["存放点", "存放区"].includes(label)) return "storage-zone";
    if (["清理点", "清理区"].includes(label)) return "cleanup-zone";
    return null;
  }

  function matchesQueryTarget(target, object) {
    const wanted = normalizeVisionName(target);
    if (!wanted) return false;
    const wantedCategory = normalizeCategory(target);
    if (wantedCategory) return canonicalCategory(object) === wantedCategory;
    const names = [object && object.label, ...((object && object.aliases) || [])].map(normalizeVisionName);
    if (names.includes(wanted)) return true;
    return Object.values(QUERY_DEFINITION.matchingAliases).some(group => (
      group.includes(wanted) && names.some(name => group.includes(name))
    ));
  }

  function displayDistanceCm(object, definition = QUERY_DEFINITION) {
    const unitsPerMeter = Number(definition?.worldUnitsPerMeter);
    const centimetersPerWorldUnit = Number.isFinite(unitsPerMeter) && unitsPerMeter > 0
      ? 100 / unitsPerMeter : 100;
    return Number.isFinite(object && object.distance)
      ? Math.round(object.distance * centimetersPerWorldUnit) : null;
  }

  function safeObservation(object, definition = QUERY_DEFINITION) {
    const confidence = Number(object && object.confidence);
    const category = canonicalCategory(object);
    const categoryLabel = definition.categoryLabels[category] || "";
    const observation = {
      category,
      categoryLabel,
      name: object && object.label || categoryLabel,
      label: object && object.label || categoryLabel,
      direction: object && object.direction || definition.centeredDirection,
      distanceCm: displayDistanceCm(object, definition),
      confidence: Number.isFinite(confidence) ? Number(confidence.toFixed(2)) : 0,
      near: Boolean(object && object.near) && (!object || object.direction === definition.centeredDirection),
      stable: !object || object.stable !== false
    };
    const explicitBearing = Number(object && object.bearingDeg);
    const measuredBearing = Number.isFinite(explicitBearing)
      ? explicitBearing
      : object && object.box ? bearingDegForBox(object.box) : null;
    if (Number.isFinite(measuredBearing)) {
      observation.bearingDeg = Number(Number(measuredBearing).toFixed(2));
    }
    return observation;
  }

  function sortQueryMatches(target, objects) {
    const wanted = normalizeVisionName(target);
    return [...objects].sort((a, b) => {
      const exact = Number(normalizeVisionName(b.label) === wanted) - Number(normalizeVisionName(a.label) === wanted);
      if (exact) return exact;
      const withDistance = Number(Number.isFinite(b.distance)) - Number(Number.isFinite(a.distance));
      if (withDistance) return withDistance;
      return Number(b.confidence || 0) - Number(a.confidence || 0);
    });
  }

  function projectQuery(method, args = [], detections = [], definition = QUERY_DEFINITION) {
    if (definition !== QUERY_DEFINITION && definition !== LEGACY_QUERY_DEFINITION) {
      throw new TypeError("unsupported virtual vision query definition");
    }
    if (!definition.methods.includes(method)) throw new RangeError(`unsupported virtual vision query: ${method}`);
    if (!Array.isArray(args)) throw new TypeError("virtual vision query args must be an array");
    if (!Array.isArray(detections)) throw new TypeError("virtual vision detections must be an array");
    const target = args[0];
    const threshold = Number(args[1]);
    const minimum = Number.isFinite(threshold) ? threshold : definition.defaultConfidence;
    let matches = detections.filter(object => Number(object && object.confidence) >= minimum);
    if (method === "observe") {
      const category = target === null || target === undefined || target === "" ? null : normalizeCategory(target);
      if (target !== null && target !== undefined && target !== "" && !category) throw new RangeError("unsupported virtual vision category");
      matches = matches.filter(object => canonicalCategory(object) && (!category || canonicalCategory(object) === category));
    } else if (target !== null && target !== undefined && target !== "") {
      matches = matches.filter(object => matchesQueryTarget(target, object));
    }
    matches = sortQueryMatches(target, matches);
    const stable = object => !object || object.stable !== false;
    const centered = object => object && object.direction === definition.centeredDirection;
    if (method === "sees") {
      const obstacleQuery = QUERY_DEFINITION.obstacleQueryAliases.includes(normalizeVisionName(target));
      return matches.some(object => stable(object) && centered(object)
        && (!obstacleQuery || object.label !== "障碍物" || (object.clearance === undefined ? object.distance : object.clearance) <= definition.avoidObstacleClearanceMeters));
    }
    if (method === "count") return matches.filter(stable).length;
    if (method === "near") return matches.some(object => stable(object) && Boolean(object.near));
    if (method === "centered") return matches.some(object => stable(object) && centered(object));
    if (method === "direction") return matches[0] && matches[0].direction || definition.missingDirection;
    if (method === "distance_to") return displayDistanceCm(matches[0], definition);
    if (method === "observe") return matches.filter(stable).map(object => safeObservation(object, definition));
    return matches.map(object => ({
      "类别": canonicalCategory(object) || object.category || "unknown",
      "名称": object.label,
      "目标物": object.label,
      "置信度": Number(Number(object.confidence).toFixed(2)),
      "距离厘米": displayDistanceCm(object, definition) === null ? "未校准" : displayDistanceCm(object, definition),
      "方位": object.direction || definition.centeredDirection,
      "已稳定": stable(object),
      "接近夹取距离": Boolean(object.near) && centered(object)
    }));
  }

  // The frozen detector implementation follows below. It consumes only frames
  // returned by prepareVirtualFrame, never mission metadata or ground truth.

  function findPixelRegions(rgba, predicate, step = DETECTOR_DEFINITION.sampling.step, seedPredicate = null) {
    const modelSize = CAMERA_DEFINITION.model.width;
    const width = Math.floor(modelSize / step);
    const height = Math.floor(modelSize / step);
    const mask = new Uint8Array(width * height);
    const sampleOffset = Math.floor(step / 2);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelX = Math.min(modelSize - 1, x * step + sampleOffset);
        const pixelY = Math.min(modelSize - 1, y * step + sampleOffset);
        const offset = (pixelY * modelSize + pixelX) * 4;
        if (predicate(rgba[offset], rgba[offset + 1], rgba[offset + 2])) mask[y * width + x] = 1;
      }
    }
    const regions = [];
    const queue = new Int32Array(width * height);
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start]) continue;
      mask[start] = 0;
      let head = 0;
      let tail = 0;
      let count = 0;
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      let seedCount = 0;
      queue[tail++] = start;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        count += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        if (seedPredicate) {
          const pixelX = Math.min(modelSize - 1, x * step + sampleOffset);
          const pixelY = Math.min(modelSize - 1, y * step + sampleOffset);
          const offset = (pixelY * modelSize + pixelX) * 4;
          if (seedPredicate(rgba[offset], rgba[offset + 1], rgba[offset + 2])) seedCount += 1;
        }
        const neighbours = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (const [dx, dy] of neighbours) {
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (!mask[next]) continue;
          mask[next] = 0;
          queue[tail++] = next;
        }
      }
      const boxCells = (maxX - minX + 1) * (maxY - minY + 1);
      regions.push({
        x: minX * step,
        y: minY * step,
        w: (maxX - minX + 1) * step,
        h: (maxY - minY + 1) * step,
        count,
        seedCount,
        coverage: count / Math.max(1, boxCells)
      });
    }
    return regions.sort((a, b) => (b.count * b.coverage) - (a.count * a.coverage));
  }

  function assertCameraCalibration(options) {
    const hasFov = options && Object.prototype.hasOwnProperty.call(options, "fovDegrees");
    const hasOffset = options && Object.prototype.hasOwnProperty.call(options, "cameraForwardOffset");
    if (hasFov && Number(options.fovDegrees) !== CAMERA_DEFINITION.verticalFovDegrees) {
      throw new RangeError(`virtual camera fovDegrees must equal the frozen ${CAMERA_DEFINITION.verticalFovDegrees}`);
    }
    if (hasOffset && Number(options.cameraForwardOffset) !== CAMERA_DEFINITION.cameraForwardOffsetMeters) {
      throw new RangeError(`virtual camera cameraForwardOffset must equal the frozen ${CAMERA_DEFINITION.cameraForwardOffsetMeters}`);
    }
    return {
      verticalFovDegrees: CAMERA_DEFINITION.verticalFovDegrees,
      cameraForwardOffsetMeters: CAMERA_DEFINITION.cameraForwardOffsetMeters
    };
  }

  function estimateVirtualDistance(frame, region, physicalWidth, calibration) {
    const config = DETECTOR_DEFINITION.distance;
    const fov = calibration.verticalFovDegrees * Math.PI / 180;
    const focalPixels = (frame.sourceHeight / 2) / Math.tan(fov / 2) * frame.scale;
    const opticalDepth = physicalWidth * focalPixels / Math.max(1, region.w);
    const opticalCenterX = frame.padX + frame.sourceWidth * frame.scale / 2;
    const horizontalAngle = Math.atan2(region.x + region.w / 2 - opticalCenterX, focalPixels);
    return clamp(opticalDepth / Math.max(config.minimumCosine, Math.cos(horizontalAngle))
      + calibration.cameraForwardOffsetMeters,
      config.outputClampMeters[0], config.outputClampMeters[1]);
  }

  function isCompactVirtualObjectRegion(region) {
    const rule = DETECTOR_DEFINITION.regionRules.compactObject;
    const ratio = region.w / Math.max(1, region.h);
    return region.w >= rule.minimumWidth && region.h >= rule.minimumHeight && region.w * region.h >= rule.minimumBoxArea
      && ratio >= rule.ratio[0] && ratio <= rule.ratio[1] && region.coverage >= rule.minimumCoverage;
  }

  function isVerticalVirtualSignRegion(region, frame) {
    const regular = DETECTOR_DEFINITION.regionRules.regularVerticalSign;
    const ratio = region.w / Math.max(1, region.h);
    if (region.w >= regular.minimumWidth && region.h >= regular.minimumHeight && region.w * region.h >= regular.minimumBoxArea
      && region.w < CAMERA_DEFINITION.model.width * regular.maximumWidthRatio
      && region.h < CAMERA_DEFINITION.model.height * regular.maximumHeightRatio
      && ratio >= regular.ratio[0] && ratio <= regular.ratio[1] && region.coverage >= regular.minimumCoverage) return true;
    const clipped = DETECTOR_DEFINITION.regionRules.clippedVerticalSign;
    const contentLeft = frame.padX;
    const contentTop = frame.padY;
    const contentRight = contentLeft + frame.sourceWidth * frame.scale;
    const contentBottom = contentTop + frame.sourceHeight * frame.scale;
    const verticalBoundary = region.y <= contentTop + clipped.boundaryTolerance
      || region.y + region.h >= contentBottom - clipped.boundaryTolerance;
    const horizontalBoundary = region.x <= contentLeft + clipped.boundaryTolerance
      || region.x + region.w >= contentRight - clipped.boundaryTolerance;
    const contentWidth = Math.max(1, contentRight - contentLeft);
    const contentHeight = Math.max(1, contentBottom - contentTop);
    return verticalBoundary && !horizontalBoundary && region.w >= clipped.minimumWidth
      && region.h >= contentHeight * clipped.minimumHeightRatio
      && region.w < contentWidth * clipped.maximumWidthRatio
      && region.w * region.h >= clipped.minimumBoxArea
      && ratio >= clipped.ratio[0] && ratio <= clipped.ratio[1]
      && region.coverage >= clipped.minimumCoverage;
  }

  function virtualPointDetection(frame, calibration, region, definition) {
    const distance = estimateVirtualDistance(frame, region, definition.physicalWidthMeters, calibration);
    return {
      label: definition.label,
      category: definition.category,
      aliases: [...definition.aliases],
      source: DETECTOR_DEFINITION.source,
      detectorVersion: `${DETECTOR_DEFINITION.id}/${DETECTOR_DEFINITION.version}`,
      confidence: clamp(definition.confidence.base + region.coverage * definition.confidence.coverageWeight,
        definition.confidence.base, definition.confidence.maximum),
      distance,
      distanceEstimated: true,
      clearance: definition.clearanceOffsetMeters === null ? undefined : Math.max(0, distance - definition.clearanceOffsetMeters),
      near: distance <= definition.nearDistanceMeters,
      minimumApproachDistance: definition.minimumApproachDistanceMeters,
      stable: true,
      direction: directionForBox(region),
      bearingDeg: Number(bearingDegForBox(region).toFixed(2)),
      box: { x: region.x, y: region.y, width: region.w, height: region.h },
      frameId: frame.frameId,
      capturedAt: frame.capturedAt
    };
  }

  function requirePreparedFrame(frame) {
    if (!frame || typeof frame !== "object") throw new TypeError("virtual detector requires a prepared frame");
    const expected = CAMERA_DEFINITION.model.width * CAMERA_DEFINITION.model.height * 4;
    if (!(frame.rgba instanceof Uint8Array) && !(frame.rgba instanceof Uint8ClampedArray)) {
      throw new TypeError("prepared virtual frame rgba must be a byte array");
    }
    if (frame.rgba.byteLength !== expected || frame.sourceWidth !== CAMERA_DEFINITION.source.width
      || frame.sourceHeight !== CAMERA_DEFINITION.source.height
      || frame.scale !== CAMERA_DEFINITION.letterbox.scale
      || frame.padX !== CAMERA_DEFINITION.letterbox.padX
      || frame.padY !== CAMERA_DEFINITION.letterbox.padY
      || frame.cameraDefinitionHash !== CAMERA_DEFINITION_HASH) {
      throw new RangeError("prepared virtual frame does not match the frozen camera definition");
    }
    return frame;
  }

  function detectVirtualPixels(preparedFrame, options = {}) {
    const frame = requirePreparedFrame(preparedFrame);
    const calibration = assertCameraCalibration(options);
    const detections = [];
    const target = DETECTOR_DEFINITION.classes.find(item => item.category === "target");
    const brightTarget = (r, g, b) => r >= 100 && g <= 92 && b <= 96 && r - g >= 55 && r - b >= 48 && r >= g * 1.55 && r >= b * 1.45;
    findPixelRegions(frame.rgba, (r, g, b) => r >= 52 && g <= 86 && b <= 92
      && r - g >= 30 && r - b >= 26 && r >= g * 1.5 && r >= b * 1.38, 2, brightTarget)
      .filter(isCompactVirtualObjectRegion)
      .filter(region => region.seedCount >= Math.max(6, region.count * 0.015)).slice(0, target.maximumRegions)
      .forEach(region => detections.push(virtualPointDetection(frame, calibration, region, target)));

    const distractor = DETECTOR_DEFINITION.classes.find(item => item.category === "distractor");
    const brightDistractor = (r, g, b) => b >= 135 && b - g >= 45 && b >= g * 1.45
      && (b - r >= 42 || (r >= 75 && b >= r * 1.18));
    findPixelRegions(frame.rgba, (r, g, b) => b >= 62 && b - g >= 30 && b >= g * 1.38
      && (b - r >= 30 || (r >= 48 && b >= r * 1.15)), 2, brightDistractor)
      .filter(isCompactVirtualObjectRegion)
      .filter(region => region.seedCount >= Math.max(6, region.count * 0.015)).slice(0, distractor.maximumRegions)
      .forEach(region => detections.push(virtualPointDetection(frame, calibration, region, distractor)));

    const storage = DETECTOR_DEFINITION.classes.find(item => item.category === "storage-zone");
    findPixelRegions(frame.rgba, (r, g, b) => g >= 90 && g - r >= 24 && g - b >= 16 && g >= r * 1.22 && g >= b * 1.16)
      .filter(region => isVerticalVirtualSignRegion(region, frame)).slice(0, storage.maximumRegions)
      .forEach(region => detections.push(virtualPointDetection(frame, calibration, region, storage)));

    const cleanup = DETECTOR_DEFINITION.classes.find(item => item.category === "cleanup-zone");
    findPixelRegions(frame.rgba, (r, g, b) => r >= 135 && g >= 55 && g <= r * 0.82 && b <= 105
      && r - g >= 35 && g - b >= 12)
      .filter(region => isVerticalVirtualSignRegion(region, frame)).slice(0, cleanup.maximumRegions)
      .forEach(region => detections.push(virtualPointDetection(frame, calibration, region, cleanup)));

    const obstacle = DETECTOR_DEFINITION.classes.find(item => item.category === "obstacle");
    const stripe = DETECTOR_DEFINITION.regionRules.obstacleStripe;
    findPixelRegions(frame.rgba, (r, g, b) => r >= 125 && g >= 100 && b <= 105 && g >= r * 0.62
      && r >= b * 1.45 && g >= b * 1.2).filter(region => {
      const ratio = region.w / Math.max(1, region.h);
      return region.w >= stripe.minimumWidth && region.h >= stripe.minimumHeight
        && region.w < CAMERA_DEFINITION.model.width * stripe.maximumWidthRatio
        && ratio >= stripe.ratio[0] && ratio <= stripe.ratio[1] && region.coverage >= stripe.minimumCoverage;
    }).slice(0, obstacle.maximumRegions).forEach(region => {
      const expansion = DETECTOR_DEFINITION.regionRules.obstacleExpansion;
      const expanded = {
        x: Math.max(0, region.x - region.w * expansion.leftWidthRatio),
        y: Math.max(0, region.y - region.h * expansion.topHeightRatio),
        w: Math.min(CAMERA_DEFINITION.model.width, region.w * expansion.widthRatio),
        h: Math.min(CAMERA_DEFINITION.model.height, region.h * expansion.heightRatio)
      };
      expanded.w = Math.min(expanded.w, CAMERA_DEFINITION.model.width - expanded.x);
      expanded.h = Math.min(expanded.h, CAMERA_DEFINITION.model.height - expanded.y);
      const distance = estimateVirtualDistance(frame, region, obstacle.physicalWidthMeters, calibration);
      const detection = {
        label: obstacle.label,
        category: obstacle.category,
        aliases: [...obstacle.aliases],
        source: DETECTOR_DEFINITION.source,
        detectorVersion: `${DETECTOR_DEFINITION.id}/${DETECTOR_DEFINITION.version}`,
        confidence: clamp(obstacle.confidence.base + region.coverage * obstacle.confidence.coverageWeight,
          obstacle.confidence.base, obstacle.confidence.maximum),
        distance,
        distanceEstimated: true,
        clearance: Math.max(0, distance - obstacle.clearanceOffsetMeters),
        near: Math.max(0, distance - obstacle.clearanceOffsetMeters) <= obstacle.nearClearanceMeters,
        stable: true,
        direction: directionForBox(region),
        bearingDeg: Number(bearingDegForBox(region).toFixed(2)),
        box: { x: Math.round(expanded.x), y: Math.round(expanded.y), width: Math.round(expanded.w), height: Math.round(expanded.h) }
      };
      if (!detections.some(existing => existing.label === detection.label
        && boxesOverlap(existing.box, detection.box) >= DETECTOR_DEFINITION.regionRules.obstacleDuplicateOverlap)) detections.push(detection);
    });

    const zones = detections.filter(item => item.category === "storage-zone" || item.category === "cleanup-zone");
    const suppression = DETECTOR_DEFINITION.regionRules.zoneSuppression;
    return detections.filter(item => {
      if (!["target", "obstacle", "distractor"].includes(item.category)) return true;
      const centerX = item.box.x + item.box.width / 2;
      const centerY = item.box.y + item.box.height / 2;
      return !zones.some(zone => boxesOverlap(item.box, zone.box) >= suppression.overlap
        || (centerX >= zone.box.x - suppression.centerMarginPixels
          && centerX <= zone.box.x + zone.box.width + suppression.centerMarginPixels
          && centerY >= zone.box.y - suppression.centerMarginPixels
          && centerY <= zone.box.y + zone.box.height + suppression.centerMarginPixels));
    }).map(item => ({ ...item, frameId: frame.frameId, capturedAt: frame.capturedAt }));
  }

  const DETECTOR_VERSION = `${DETECTOR_DEFINITION.id}/${DETECTOR_DEFINITION.version}`;
  return deepFreeze({
    CAMERA_DEFINITION,
    CAMERA_DEFINITION_HASH,
    DETECTOR_DEFINITION,
    DETECTOR_DEFINITION_HASH,
    LEGACY_QUERY_DEFINITION,
    LEGACY_QUERY_DEFINITION_HASH,
    QUERY_DEFINITION,
    QUERY_DEFINITION_HASH,
    LEGACY_VISION_DEFINITION,
    LEGACY_VISION_DEFINITION_HASH,
    VISION_DEFINITION,
    VISION_DEFINITION_HASH,
    DETECTOR_VERSION,
    prepareVirtualFrame,
    detectVirtualPixels,
    projectQuery,
    boxesOverlap,
    directionForBox,
    bearingDegForBox,
    normalizeCategory,
    canonicalCategory,
    matchesQueryTarget,
    displayDistanceCm
  });
});
