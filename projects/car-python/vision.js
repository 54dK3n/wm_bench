(() => {
  const pixelCore = window.CarVisionPixelCore;
  if (!pixelCore?.prepareVirtualFrame || !pixelCore?.detectVirtualPixels) {
    throw new Error("虚拟像素识别核心未加载。请先加载 vision-pixel-core.js。");
  }
  const MODEL_SIZE = pixelCore.CAMERA_DEFINITION.model.width;
  const SCORE_THRESHOLD = 0.38;
  const NMS_THRESHOLD = 0.45;
  const FRAME_INTERVAL = 700;
  const FRESH_FRAME_MS = 2500;
  const TEMPLATE_KEY = "chenlongVisionTemplatesV1";
  const VIRTUAL_DETECTOR_VERSION = pixelCore.DETECTOR_VERSION;
  const COCO = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
    "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed",
    "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
    "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
  ];

  const state = {
    enabled: false,
    loading: false,
    running: false,
    yoloRunning: false,
    session: null,
    modelPromise: null,
    modelAttempt: 0,
    modelRetryAfter: 0,
    modelError: "",
    image: null,
    timer: null,
    detections: [],
    namedDetections: [],
    virtualDetections: [],
    yoloDetections: [],
    namedTracks: new Map(),
    status: "\u89c6\u89c9\u8bc6\u522b\u7b49\u5f85\u542f\u52a8",
    error: "",
    onUpdate: null,
    frame: null,
    teachingFrame: null,
    frameId: 0,
    updatedAt: 0,
    generation: 0,
    manual: false,
    sourceMode: "camera",
    frameOptions: {},
    templates: loadTemplates()
  };

  const canvas = document.createElement("canvas");
  canvas.width = MODEL_SIZE;
  canvas.height = MODEL_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const virtualSourceCanvas = document.createElement("canvas");
  virtualSourceCanvas.width = pixelCore.CAMERA_DEFINITION.source.width;
  virtualSourceCanvas.height = pixelCore.CAMERA_DEFINITION.source.height;
  const virtualSourceContext = virtualSourceCanvas.getContext("2d", { willReadFrequently: true });

  function normalizeName(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function sourceDimensions(source) {
    return {
      width: Number(source?.naturalWidth || source?.videoWidth || source?.width || 0),
      height: Number(source?.naturalHeight || source?.videoHeight || source?.height || 0)
    };
  }

  function sampleList(template) {
    if (Array.isArray(template?.samplesData) && template.samplesData.length) return template.samplesData;
    if (template?.profile) {
      return [{
        profile: template.profile,
        referenceDistanceCm: Number(template.referenceDistanceCm) || 30,
        createdAt: template.createdAt || Date.now()
      }];
    }
    return [];
  }

  function loadTemplates() {
    try {
      const parsed = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(item => item?.name && item?.profile).map(item => {
        const samplesData = sampleList(item).filter(sample => sample?.profile);
        return {
          ...item,
          samples: Math.max(1, Number(item.samples) || samplesData.length || 1),
          referenceDistanceCm: Number(item.referenceDistanceCm) || Number(samplesData[0]?.referenceDistanceCm) || 30,
          samplesData: samplesData.slice(-8)
        };
      });
    } catch {
      return [];
    }
  }

  function persistTemplates() {
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(state.templates));
  }

  function report(status, error = state.error) {
    state.status = status;
    state.error = error;
    state.onUpdate?.({
      status,
      error,
      detections: state.detections,
      sharpness: state.frame?.sharpness || 0,
      modelError: state.modelError,
      templates: state.templates.length,
      frameId: state.frameId,
      updatedAt: state.updatedAt
    });
  }

  function currentStatusText() {
    if (state.sourceMode === "virtual") {
      return state.detections.length
        ? `虚拟车载摄像头已就绪，识别到 ${state.detections.length} 个目标`
        : "虚拟车载摄像头已就绪，暂未识别到目标";
    }
    const found = state.detections.length
      ? `\uff0c\u8bc6\u522b\u5230 ${state.detections.length} \u4e2a\u76ee\u6807`
      : "\uff0c\u6682\u672a\u8bc6\u522b\u5230\u76ee\u6807";
    const blur = state.frame?.sharpness < 18
      ? `\u3002\u753b\u9762\u8f83\u6a21\u7cca\uff08\u6e05\u6670\u5ea6 ${state.frame.sharpness}\uff09\uff0c\u8bf7\u505c\u7a33\u6216\u9760\u8fd1\u76ee\u6807\u3002`
      : "";
    if (state.session) return `通用物体识别（YOLO）已就绪${found}${blur}`;
    if (state.loading) {
      const prefix = state.templates.length
        ? "命名目标库已就绪，正在加载通用物体识别（YOLO）"
        : "正在加载通用物体识别（YOLO）";
      return `${prefix}\u2026${state.templates.length ? found : ""}${blur}`;
    }
    if (state.modelError) {
      return state.templates.length
        ? `命名目标库已就绪${found}。通用物体识别（YOLO）当前不可用；已训练的命名目标仍可正常识别。${blur}`
        : "通用物体识别（YOLO）当前不可用。";
    }
    return `正在准备本地视觉识别…${blur}`;
  }

  function publishFrameStatus() {
    const modelBlocksVision = state.sourceMode !== "virtual" && state.modelError && !state.templates.length;
    report(currentStatusText(), modelBlocksVision ? state.modelError : "");
  }

  function scheduleNext(delay = FRAME_INTERVAL) {
    if (!state.enabled || state.manual) return;
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(inferOnce, delay);
  }

  function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
  }

  function hueDistance(a, b) {
    const delta = Math.abs(a - b);
    return Math.min(delta, 1 - delta);
  }

  function rgbToHsv(r, g, b) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
      else if (max === green) hue = ((blue - red) / delta + 2) / 6;
      else hue = ((red - green) / delta + 4) / 6;
    }
    return { hue, saturation: max ? delta / max : 0, value: max };
  }

  function calculateSharpness(rgba) {
    const step = 4;
    const width = MODEL_SIZE / step;
    const height = MODEL_SIZE / step;
    const gray = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = ((y * step) * MODEL_SIZE + x * step) * 4;
        gray[y * width + x] = rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114;
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
      { x: a.x, y: a.y, w: a.width ?? a.w, h: a.height ?? a.h },
      { x: b.x, y: b.y, w: b.width ?? b.w, h: b.height ?? b.h }
    );
  }

  function suppress(candidates) {
    const kept = [];
    for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
      if (kept.length >= 24) break;
      if (!kept.some(existing => existing.classId === candidate.classId && overlap(existing, candidate) >= NMS_THRESHOLD)) {
        kept.push(candidate);
      }
    }
    return kept;
  }

  function redRatio(box, rgba) {
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(MODEL_SIZE, Math.ceil(box.x + box.w));
    const y1 = Math.min(MODEL_SIZE, Math.ceil(box.y + box.h));
    if (x1 <= x0 || y1 <= y0) return 0;
    let red = 0;
    let total = 0;
    const stride = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 400)));
    for (let y = y0; y < y1; y += stride) {
      for (let x = x0; x < x1; x += stride) {
        const offset = (y * MODEL_SIZE + x) * 4;
        const r = rgba[offset];
        const g = rgba[offset + 1];
        const b = rgba[offset + 2];
        if (r > 75 && r > g * 1.35 && r > b * 1.35) red += 1;
        total += 1;
      }
    }
    return total ? red / total : 0;
  }

  function directionForBox(box) {
    const center = box.x + box.w / 2;
    return center < MODEL_SIZE * 0.42 ? "\u5de6" : center > MODEL_SIZE * 0.58 ? "\u53f3" : "\u4e2d\u95f4";
  }

  function toStudentDetection(candidate, rgba) {
    const isRedBall = candidate.classId === 32 && redRatio(candidate, rgba) >= 0.1;
    const label = isRedBall ? "\u7ea2\u7403" : "\u969c\u788d\u7269";
    const aliases = isRedBall
      ? ["\u7403", "\u5305\u88f9", "\u76ee\u6807\u7269", "sports ball"]
      : ["\u969c\u788d", "\u65b9\u5757", "\u5899", COCO[candidate.classId]];
    const apparentSize = Math.max(candidate.w, candidate.h) / MODEL_SIZE;
    return {
      label,
      category: isRedBall ? "target" : "obstacle",
      aliases,
      source: "yolo",
      confidence: candidate.confidence,
      distance: null,
      clearance: isRedBall ? undefined : apparentSize >= 0.18 ? 0.7 : 2,
      near: false,
      stable: true,
      direction: directionForBox(candidate),
      box: {
        x: Math.round(candidate.x), y: Math.round(candidate.y),
        width: Math.round(candidate.w), height: Math.round(candidate.h)
      }
    };
  }

  function decode(output, scale, padX, padY, rgba) {
    const values = output.data;
    const candidates = [];
    const columns = 8400;
    for (let index = 0; index < columns; index += 1) {
      let classId = -1;
      let confidence = SCORE_THRESHOLD;
      for (let classIndex = 0; classIndex < 80; classIndex += 1) {
        const score = values[(4 + classIndex) * columns + index];
        if (score > confidence) {
          confidence = score;
          classId = classIndex;
        }
      }
      if (classId < 0) continue;
      const width = values[2 * columns + index];
      const height = values[3 * columns + index];
      const x = values[index] - width / 2;
      const y = values[columns + index] - height / 2;
      const sourceBox = {
        classId,
        confidence,
        x: Math.max(0, (x - padX) / scale),
        y: Math.max(0, (y - padY) / scale),
        w: Math.max(0, width / scale),
        h: Math.max(0, height / scale)
      };
      if (sourceBox.w >= 3 && sourceBox.h >= 3) candidates.push(sourceBox);
    }
    return suppress(candidates).map(candidate => ({
      ...candidate,
      x: candidate.x * scale + padX,
      y: candidate.y * scale + padY,
      w: candidate.w * scale,
      h: candidate.h * scale
    })).map(candidate => toStudentDetection(candidate, rgba));
  }

  function imageToFrame(image, { createModelInput = true } = {}) {
    const { width: sourceWidth, height: sourceHeight } = sourceDimensions(image);
    if (!sourceWidth || !sourceHeight) return null;
    const scale = Math.min(MODEL_SIZE / sourceWidth, MODEL_SIZE / sourceHeight);
    const drawWidth = Math.round(sourceWidth * scale);
    const drawHeight = Math.round(sourceHeight * scale);
    const padX = Math.floor((MODEL_SIZE - drawWidth) / 2);
    const padY = Math.floor((MODEL_SIZE - drawHeight) / 2);
    context.fillStyle = "#000";
    context.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
    context.drawImage(image, padX, padY, drawWidth, drawHeight);
    const imageData = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
    const rgba = imageData.data;
    const input = createModelInput ? new Float32Array(3 * MODEL_SIZE * MODEL_SIZE) : null;
    const plane = MODEL_SIZE * MODEL_SIZE;
    for (let pixel = 0; pixel < plane; pixel += 1) {
      const offset = pixel * 4;
      // Mild contrast expansion helps both YOLO and template matching on the
      // low-bitrate real-camera stream. The teaching image uses the same pixels.
      const red = Math.round(clamp(((rgba[offset] - 128) * 1.12 + 128) / 255) * 255);
      const green = Math.round(clamp(((rgba[offset + 1] - 128) * 1.12 + 128) / 255) * 255);
      const blue = Math.round(clamp(((rgba[offset + 2] - 128) * 1.12 + 128) / 255) * 255);
      rgba[offset] = red;
      rgba[offset + 1] = green;
      rgba[offset + 2] = blue;
      if (input) {
        input[pixel] = red / 255;
        input[plane + pixel] = green / 255;
        input[plane * 2 + pixel] = blue / 255;
      }
    }
    return {
      input,
      rgba,
      imageData,
      scale,
      padX,
      padY,
      sourceWidth,
      sourceHeight,
      sharpness: calculateSharpness(rgba)
    };
  }

  function imageToVirtualFrame(image) {
    const { width, height } = sourceDimensions(image);
    const camera = pixelCore.CAMERA_DEFINITION.source;
    if (width !== camera.width || height !== camera.height) {
      throw new RangeError(`虚拟车载摄像头画面必须为 ${camera.width}x${camera.height} RGBA。`);
    }
    let imageData = null;
    const sourceContext = typeof image?.getContext === "function"
      ? image.getContext("2d", { willReadFrequently: true })
      : null;
    if (sourceContext?.getImageData) {
      imageData = sourceContext.getImageData(0, 0, camera.width, camera.height);
    } else {
      if (!virtualSourceContext) throw new Error("浏览器无法读取虚拟车载摄像头画面。");
      virtualSourceContext.clearRect(0, 0, camera.width, camera.height);
      virtualSourceContext.drawImage(image, 0, 0, camera.width, camera.height);
      imageData = virtualSourceContext.getImageData(0, 0, camera.width, camera.height);
    }
    return pixelCore.prepareVirtualFrame(imageData.data);
  }

  function profileFromBox(imageData, box) {
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(MODEL_SIZE, Math.ceil(box.x + box.width));
    const y1 = Math.min(MODEL_SIZE, Math.ceil(box.y + box.height));
    if (x1 - x0 < 24 || y1 - y0 < 24) {
      throw new Error("\u6846\u9009\u533a\u57df\u592a\u5c0f\uff0c\u8bf7\u8ba9\u7269\u4f53\u66f4\u9760\u8fd1\u6444\u50cf\u5934\u540e\u91cd\u65b0\u6846\u9009\u3002");
    }
    const { data } = imageData;
    let count = 0;
    let colorCount = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumS = 0;
    let sumV = 0;
    let hueX = 0;
    let hueY = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const offset = (y * MODEL_SIZE + x) * 4;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const hsv = rgbToHsv(r, g, b);
        if (hsv.value < 0.08) continue;
        count += 1;
        sumR += r;
        sumG += g;
        sumB += b;
        sumS += hsv.saturation;
        sumV += hsv.value;
        if (hsv.saturation >= 0.18) {
          colorCount += 1;
          hueX += Math.cos(hsv.hue * Math.PI * 2) * hsv.saturation;
          hueY += Math.sin(hsv.hue * Math.PI * 2) * hsv.saturation;
        }
      }
    }
    if (count < 80) throw new Error("\u6ca1\u6709\u91c7\u5230\u8db3\u591f\u7684\u56fe\u50cf\u5185\u5bb9\uff0c\u8bf7\u91cd\u65b0\u6846\u9009\u7269\u4f53\u3002");
    const colored = colorCount / count;
    const hue = ((Math.atan2(hueY, hueX) / (Math.PI * 2)) + 1) % 1;
    const concentration = Math.hypot(hueX, hueY) / Math.max(1, colorCount);
    return {
      mode: colored >= 0.22 && concentration >= 0.25 ? "color" : "rgb",
      hue,
      hueTolerance: clamp(0.055 + (1 - concentration) * 0.1, 0.055, 0.17),
      saturation: sumS / count,
      value: sumV / count,
      r: sumR / count,
      g: sumG / count,
      b: sumB / count,
      colored,
      area: ((x1 - x0) * (y1 - y0)) / (MODEL_SIZE * MODEL_SIZE)
    };
  }

  function mergeProfile(oldProfile, nextProfile, oldSamples) {
    const weight = Math.max(1, oldSamples);
    const total = weight + 1;
    const oldX = Math.cos(oldProfile.hue * Math.PI * 2) * weight;
    const oldY = Math.sin(oldProfile.hue * Math.PI * 2) * weight;
    const nextX = Math.cos(nextProfile.hue * Math.PI * 2);
    const nextY = Math.sin(nextProfile.hue * Math.PI * 2);
    return {
      mode: oldProfile.mode === "color" || nextProfile.mode === "color" ? "color" : "rgb",
      hue: ((Math.atan2(oldY + nextY, oldX + nextX) / (Math.PI * 2)) + 1) % 1,
      hueTolerance: clamp((oldProfile.hueTolerance * weight + nextProfile.hueTolerance) / total + 0.006, 0.055, 0.2),
      saturation: (oldProfile.saturation * weight + nextProfile.saturation) / total,
      value: (oldProfile.value * weight + nextProfile.value) / total,
      r: (oldProfile.r * weight + nextProfile.r) / total,
      g: (oldProfile.g * weight + nextProfile.g) / total,
      b: (oldProfile.b * weight + nextProfile.b) / total,
      colored: (oldProfile.colored * weight + nextProfile.colored) / total,
      area: (oldProfile.area * weight + nextProfile.area) / total
    };
  }

  function templatePixelMatch(profile, r, g, b) {
    const hsv = rgbToHsv(r, g, b);
    const rgbDistance = Math.hypot(r - profile.r, g - profile.g, b - profile.b) / 255;
    if (profile.mode === "color") {
      return hsv.value >= Math.max(0.1, profile.value - 0.42)
        && hsv.saturation >= Math.max(0.18, profile.saturation * 0.48)
        && hueDistance(hsv.hue, profile.hue) <= profile.hueTolerance
        && rgbDistance <= 0.58;
    }
    return rgbDistance <= 0.18 && hsv.value >= Math.max(0.1, profile.value - 0.3);
  }

  function findTemplateRegions(profile, rgba) {
    const step = 4;
    const width = MODEL_SIZE / step;
    const height = MODEL_SIZE / step;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = ((y * step + 2) * MODEL_SIZE + x * step + 2) * 4;
        if (templatePixelMatch(profile, rgba[offset], rgba[offset + 1], rgba[offset + 2])) mask[y * width + x] = 1;
      }
    }
    const regions = [];
    const queue = new Int32Array(width * height);
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start]) continue;
      mask[start] = 0;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      let count = 0;
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        count += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (mask[next]) {
            mask[next] = 0;
            queue[tail++] = next;
          }
        }
      }
      const cells = (maxX - minX + 1) * (maxY - minY + 1);
      const coverage = count / Math.max(1, cells);
      if (count < 8 || coverage < 0.18) continue;
      regions.push({
        x: minX * step,
        y: minY * step,
        w: (maxX - minX + 1) * step,
        h: (maxY - minY + 1) * step,
        count,
        coverage
      });
    }
    return regions.sort((a, b) => (b.count * b.coverage) - (a.count * a.coverage)).slice(0, 3);
  }

  function trackNamedResult(result) {
    const prior = state.namedTracks.get(result.label);
    const now = Date.now();
    const priorCenterX = prior ? prior.box.x + prior.box.width / 2 : 0;
    const priorCenterY = prior ? prior.box.y + prior.box.height / 2 : 0;
    const nextCenterX = result.box.x + result.box.width / 2;
    const nextCenterY = result.box.y + result.box.height / 2;
    const centerShift = Math.hypot(nextCenterX - priorCenterX, nextCenterY - priorCenterY);
    const targetScale = prior ? Math.max(prior.box.width, prior.box.height, result.box.width, result.box.height) : 0;
    // A nearby target grows quickly between frames. Keep its stability track when
    // its centre remains close, rather than requiring a large box overlap.
    const priorIsConsecutive = prior
      && prior.frameId === state.frameId - 1
      && now - prior.updatedAt <= FRESH_FRAME_MS;
    const sameTarget = priorIsConsecutive && (
      boxesOverlap(prior.box, result.box) >= 0.12
      || centerShift <= Math.max(36, targetScale * 0.65)
    );
    const hits = sameTarget ? Math.min(4, prior.hits + 1) : 1;
    state.namedTracks.set(result.label, { box: result.box, hits, frameId: state.frameId, updatedAt: now });
    result.stable = hits >= 2;
    result.confidence = clamp(result.confidence * (result.stable ? 1 : 0.84));
    return result;
  }

  function detectNamedObjects(rgba) {
    const results = [];
    for (const template of state.templates) {
      let best = null;
      for (const sample of sampleList(template)) {
        const region = findTemplateRegions(sample.profile, rgba)[0];
        if (!region) continue;
        const score = region.coverage * 0.7 + Math.min(0.3, region.count / 160);
        if (!best || score > best.score) best = { region, sample, score };
      }
      if (!best) continue;
      const { region, sample } = best;
      const profile = sample.profile;
      const area = region.w * region.h / (MODEL_SIZE * MODEL_SIZE);
      const referenceArea = profile.area || area;
      const referenceDistanceCm = Number(sample.referenceDistanceCm) || Number(template.referenceDistanceCm) || 30;
      const estimatedDistanceCm = referenceDistanceCm * Math.sqrt(referenceArea / Math.max(area, 0.0001));
      const near = estimatedDistanceCm <= referenceDistanceCm * 1.12;
      results.push(trackNamedResult({
        label: template.name,
        category: "target",
        aliases: [template.name],
        source: "teaching",
        confidence: clamp(0.5 + region.coverage * 0.34 + Math.min(0.12, region.count / 180)),
        distance: clamp(estimatedDistanceCm / 12.5, 0.05, 8),
        distanceEstimated: true,
        clearance: near ? 0.7 : 2,
        near,
        direction: directionForBox(region),
        box: { x: region.x, y: region.y, width: region.w, height: region.h }
      }));
    }
    return results;
  }

  function mergeDetections(named, yolo) {
    const filteredYolo = yolo.filter(yoloObject => !named.some(namedObject => (
      namedObject.label === yoloObject.label
      && boxesOverlap(namedObject.box, yoloObject.box) >= 0.18
    )));
    return [...named, ...filteredYolo];
  }

  function createSessionWithTimeout() {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error("通用物体识别（YOLO）加载超时。已训练的命名目标仍可使用，稍后会自动重试。"));
      }, 60000);
      window.ort.InferenceSession.create("./vendor/vision/yolov8n-fp16.onnx", {
        executionProviders: ["wasm"]
      }).then(session => {
        window.clearTimeout(timeout);
        resolve(session);
      }).catch(error => {
        window.clearTimeout(timeout);
        reject(error);
      });
    });
  }

  function ensureModelLoading(generation) {
    if (state.session || state.loading || Date.now() < state.modelRetryAfter) return;
    const attempt = ++state.modelAttempt;
    state.loading = true;
    state.modelError = "";
    publishFrameStatus();
    state.modelPromise = (async () => {
      if (!window.ort) throw new Error("\u672c\u5730 YOLO \u63a8\u7406\u7ec4\u4ef6\u6ca1\u6709\u52a0\u8f7d\u3002");
      // ONNX Runtime resolves a relative WASM path from its own script folder.
      // Use a page-absolute URL so it does not become vendor/vision/vendor/vision.
      window.ort.env.wasm.wasmPaths = new URL("./vendor/vision/", window.location.href).href;
      window.ort.env.wasm.numThreads = 1;
      return createSessionWithTimeout();
    })();
    state.modelPromise.then(session => {
      if (state.modelAttempt !== attempt || state.generation !== generation) {
        session?.release?.();
        return;
      }
      state.session = session;
      state.modelError = "";
      publishFrameStatus();
      scheduleNext(0);
    }).catch(error => {
      if (state.modelAttempt !== attempt || state.generation !== generation) return;
      state.modelError = String(error?.message || error);
      state.modelRetryAfter = Date.now() + 15000;
      publishFrameStatus();
    }).finally(() => {
      if (state.modelAttempt !== attempt) return;
      state.loading = false;
      state.modelPromise = null;
    });
  }

  async function runYoloInference(session, frame, generation) {
    state.yoloRunning = true;
    try {
      const input = new window.ort.Tensor("float32", frame.input, [1, 3, MODEL_SIZE, MODEL_SIZE]);
      const output = await session.run({ [session.inputNames[0]]: input });
      if (!state.enabled || generation !== state.generation || session !== state.session) return;
      if (frame.frameId !== state.frameId) return;
      state.yoloDetections = decode(output[session.outputNames[0]], frame.scale, frame.padX, frame.padY, frame.rgba)
        .map(item => ({ ...item, capturedAt: frame.capturedAt, frameId: frame.frameId }));
      state.detections = mergeDetections(
        [...state.virtualDetections, ...state.namedDetections],
        state.yoloDetections
      );
      publishFrameStatus();
    } catch (error) {
      if (!state.enabled || generation !== state.generation) return;
      state.session = null;
      state.yoloDetections = [];
      state.modelError = String(error?.message || error);
      state.modelRetryAfter = Date.now() + 15000;
      state.detections = mergeDetections(
        [...state.virtualDetections, ...state.namedDetections],
        state.yoloDetections
      );
      publishFrameStatus();
    } finally {
      state.yoloRunning = false;
    }
  }

  function processImageFrame(image, generation, options = {}) {
    // Virtual competition frames never consult local teaching templates or
    // YOLO, even when an untrusted caller asks for it in frame options.
    const useYolo = state.sourceMode !== "virtual";
    const frame = useYolo
      ? imageToFrame(image, { createModelInput: true })
      : imageToVirtualFrame(image);
    if (!frame) return null;
    if (!state.enabled || generation !== state.generation) return null;
    frame.frameId = ++state.frameId;
    frame.capturedAt = Date.now();
    state.frame = frame;
    state.updatedAt = frame.capturedAt;
    state.virtualDetections = state.sourceMode === "virtual"
      ? pixelCore.detectVirtualPixels(frame, options)
      : [];
    state.namedDetections = state.sourceMode === "virtual" ? [] : detectNamedObjects(frame.rgba);
    if (state.sourceMode === "virtual") state.yoloDetections = [];
    state.detections = mergeDetections(
      [...state.virtualDetections, ...state.namedDetections],
      state.yoloDetections
    );
    publishFrameStatus();

    if (useYolo) {
      ensureModelLoading(generation);
      const session = state.session;
      if (session && !state.yoloRunning) void runYoloInference(session, frame, generation);
    }
    return frame;
  }

  function inferOnce() {
    const generation = state.generation;
    if (!state.enabled || !state.image) return;
    if (state.running) {
      scheduleNext(120);
      return;
    }
    const dimensions = sourceDimensions(state.image);
    if (!(dimensions.width && dimensions.height)) {
      report("\u7b49\u5f85\u6444\u50cf\u5934\u7b2c\u4e00\u5e27\u2026", "");
      scheduleNext(250);
      return;
    }
    state.running = true;
    try {
      const frame = processImageFrame(state.image, generation, state.frameOptions);
      if (!frame) {
        report("\u7b49\u5f85\u6444\u50cf\u5934\u753b\u9762\u2026", "");
        return;
      }
    } catch (error) {
      if (generation !== state.generation) return;
      state.detections = [];
      state.namedDetections = [];
      state.virtualDetections = [];
      state.yoloDetections = [];
      state.frame = null;
      state.teachingFrame = null;
      state.updatedAt = 0;
      const message = String(error?.message || error);
      const cors = /tainted|cross-origin|securityerror/i.test(message);
      state.error = cors
        ? "\u6444\u50cf\u5934\u89c6\u9891\u6d41\u672a\u5141\u8bb8\u6d4f\u89c8\u5668\u8bfb\u53d6\u56fe\u50cf\u3002\u8bf7\u5728\u5c0f\u8f66\u7aef\u542f\u7528 CORS\uff08Access-Control-Allow-Origin\uff09\u540e\u91cd\u8bd5\u3002"
        : message;
      report("\u89c6\u89c9\u8bc6\u522b\u65e0\u6cd5\u8bfb\u53d6\u6444\u50cf\u5934\u3002", state.error);
      state.enabled = false;
    } finally {
      state.running = false;
      if (state.enabled && generation === state.generation) scheduleNext();
    }
  }

  function isFreshFrame() {
    return Boolean(state.enabled && state.frame && state.updatedAt && Date.now() - state.updatedAt <= FRESH_FRAME_MS);
  }

  window.CarVision = {
    detectorVersion: VIRTUAL_DETECTOR_VERSION,
    cameraDefinition: pixelCore.CAMERA_DEFINITION,
    cameraDefinitionHash: pixelCore.CAMERA_DEFINITION_HASH,
    detectorDefinition: pixelCore.DETECTOR_DEFINITION,
    detectorDefinitionHash: pixelCore.DETECTOR_DEFINITION_HASH,
    queryDefinition: pixelCore.QUERY_DEFINITION,
    queryDefinitionHash: pixelCore.QUERY_DEFINITION_HASH,
    start(image, onUpdate) {
      this.stop();
      state.enabled = true;
      state.manual = false;
      state.sourceMode = "camera";
      state.frameOptions = {};
      state.image = image;
      state.onUpdate = onUpdate;
      state.detections = [];
      state.namedDetections = [];
      state.virtualDetections = [];
      state.yoloDetections = [];
      state.namedTracks.clear();
      state.error = "";
      state.modelError = "";
      state.modelRetryAfter = 0;
      report("\u6b63\u5728\u7b49\u5f85\u6444\u50cf\u5934\u7b2c\u4e00\u5e27\u2026", "");
      scheduleNext(0);
    },
    async analyzeFrame(image, options = {}) {
      const sourceMode = options.source === "virtual" ? "virtual" : "camera";
      if (!image) throw new TypeError("视觉帧不能为空。");
      if (!state.enabled || !state.manual || state.sourceMode !== sourceMode) {
        if (state.timer) window.clearTimeout(state.timer);
        state.timer = null;
        state.generation += 1;
        state.enabled = true;
        state.manual = true;
        state.sourceMode = sourceMode;
        state.detections = [];
        state.namedDetections = [];
        state.virtualDetections = [];
        state.yoloDetections = [];
        state.namedTracks.clear();
        state.frame = null;
        state.updatedAt = 0;
        state.error = "";
      }
      state.image = image;
      state.frameOptions = { ...options };
      const generation = state.generation;
      if (state.running) throw new Error("上一帧视觉分析尚未完成。");
      state.running = true;
      try {
        const frame = processImageFrame(image, generation, state.frameOptions);
        if (!frame) throw new Error("无法读取虚拟摄像头画面。");
        return { ...this.getStatus(), frameId: state.frameId };
      } finally {
        state.running = false;
      }
    },
    stop(reason = "") {
      state.enabled = false;
      state.manual = false;
      state.sourceMode = "camera";
      state.frameOptions = {};
      state.generation += 1;
      state.modelAttempt += 1;
      state.loading = false;
      state.modelPromise = null;
      if (state.timer) window.clearTimeout(state.timer);
      state.timer = null;
      state.image = null;
      state.frame = null;
      state.teachingFrame = null;
      state.updatedAt = 0;
      state.frameId += 1;
      state.detections = [];
      state.namedDetections = [];
      state.virtualDetections = [];
      state.yoloDetections = [];
      state.namedTracks.clear();
      state.error = reason;
      if (reason) report("\u6444\u50cf\u5934\u753b\u9762\u5df2\u4e2d\u65ad\u3002", reason);
    },
    cameraError(message) {
      this.stop(message || "\u6444\u50cf\u5934\u89c6\u9891\u6d41\u8fde\u63a5\u5931\u8d25\u3002");
    },
    getDetections() {
      return state.detections.map(item => ({ ...item, aliases: [...item.aliases], box: { ...item.box } }));
    },
    getStatus() {
      const fresh = isFreshFrame();
      return {
        ready: Boolean(fresh && (state.sourceMode === "virtual" || state.session || state.templates.length)),
        loading: state.loading || (!fresh && !state.error),
        error: state.error || (state.sourceMode !== "virtual" && state.modelError && !state.templates.length ? state.modelError : ""),
        modelError: state.modelError,
        status: state.status,
        sharpness: state.frame?.sharpness || 0,
        templates: state.templates.length,
        frameId: state.frameId,
        updatedAt: state.updatedAt,
        source: state.sourceMode,
        detectorVersion: VIRTUAL_DETECTOR_VERSION,
        fresh
      };
    },
    kick() {
      if (state.enabled) scheduleNext(0);
    },
    retryModel() {
      if (!state.enabled) return { ok: false, message: "虚拟摄像头尚未启动，请等待模拟场景准备完成。" };
      if (state.session) return { ok: true, ready: true, message: "通用物体识别（YOLO）已经就绪。" };
      if (state.loading) return { ok: true, loading: true, message: "通用物体识别（YOLO）正在加载。" };
      state.modelError = "";
      state.modelRetryAfter = 0;
      publishFrameStatus();
      scheduleNext(0);
      return { ok: true, message: "正在重新加载通用物体识别（YOLO）。" };
    },
    beginTeaching() {
      if (!isFreshFrame()) {
        throw new Error("\u8bf7\u5148\u7b49\u5f85\u6444\u50cf\u5934\u753b\u9762\u51fa\u73b0\uff0c\u518d\u5f00\u59cb\u793a\u6559\u8bad\u7ec3\u3002");
      }
      state.teachingFrame = state.frame.imageData;
      return {
        imageData: state.teachingFrame,
        sharpness: state.frame.sharpness,
        templates: this.listTemplates()
      };
    },
    saveTeachingSample({ name, box, distanceCm }) {
      const objectName = normalizeName(name);
      if (!objectName) throw new Error("\u8bf7\u5148\u7ed9\u7269\u4f53\u8d77\u4e00\u4e2a\u540d\u79f0\uff0c\u4f8b\u5982\u201c\u7ea2\u7403\u201d\u3002");
      if (objectName.length > 20) throw new Error("\u7269\u4f53\u540d\u79f0\u4e0d\u8981\u8d85\u8fc7 20 \u4e2a\u5b57\u3002");
      if (!state.teachingFrame) throw new Error("\u8bf7\u5148\u62cd\u6444\u4e00\u5e27\u8bad\u7ec3\u753b\u9762\u3002");
      const profile = profileFromBox(state.teachingFrame, box);
      const distance = Number(distanceCm);
      if (!Number.isFinite(distance) || distance < 5 || distance > 200) {
        throw new Error("目标物距离请填写 5 到 200 厘米之间的数字。");
      }
      const sample = { profile, referenceDistanceCm: distance, createdAt: Date.now() };
      const existing = state.templates.find(item => item.name === objectName);
      if (existing) {
        const samplesData = sampleList(existing);
        samplesData.push(sample);
        existing.samplesData = samplesData.slice(-8);
        existing.samples = existing.samplesData.length;
        existing.profile = mergeProfile(existing.profile, profile, Math.max(1, existing.samples - 1));
        // Kept only as a backwards-compatible summary for old data. Each
        // samplesData item still retains its own distance and is used for
        // distance estimation when that sample matches the current frame.
        existing.referenceDistanceCm = Math.round(existing.samplesData.reduce((total, item) => total + item.referenceDistanceCm, 0) / existing.samplesData.length);
        existing.updatedAt = Date.now();
      } else {
        state.templates.push({
          id: globalThis.crypto?.randomUUID?.() || `object-${Date.now()}`,
          name: objectName,
          profile,
          samples: 1,
          samplesData: [sample],
          referenceDistanceCm: Math.round(distance),
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
      persistTemplates();
      publishFrameStatus();
      return this.listTemplates();
    },
    listTemplates() {
      return state.templates.map(item => {
        const samples = sampleList(item);
        const sampleDistancesCm = samples
          .map(sample => Math.round(Number(sample?.referenceDistanceCm)))
          .filter(Number.isFinite);
        return {
          id: item.id,
          name: item.name,
          samples: item.samples || sampleDistancesCm.length || 1,
          referenceDistanceCm: item.referenceDistanceCm,
          sampleDistancesCm
        };
      });
    },
    removeTemplate(id) {
      const before = state.templates.length;
      state.templates = state.templates.filter(item => item.id !== id);
      if (state.templates.length !== before) {
        persistTemplates();
        publishFrameStatus();
      }
      return this.listTemplates();
    }
  };
})();
