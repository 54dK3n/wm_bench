const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const pixelCoreSource = fs.readFileSync(path.join(root, "vision-pixel-core.js"), "utf8");
const visionSource = fs.readFileSync(path.join(root, "vision.js"), "utf8");

function parseFillStyle(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "#000" || normalized === "#000000" || normalized === "black") return [0, 0, 0, 255];
  throw new Error(`unsupported fake-canvas fillStyle: ${value}`);
}

class FakeCanvasContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = "#000";
  }

  fillRect(x, y, width, height) {
    const [red, green, blue, alpha] = parseFillStyle(this.fillStyle);
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.canvas.width, Math.ceil(x + width));
    const y1 = Math.min(this.canvas.height, Math.ceil(y + height));
    for (let row = y0; row < y1; row += 1) {
      for (let column = x0; column < x1; column += 1) {
        const offset = (row * this.canvas.width + column) * 4;
        this.canvas.pixels[offset] = red;
        this.canvas.pixels[offset + 1] = green;
        this.canvas.pixels[offset + 2] = blue;
        this.canvas.pixels[offset + 3] = alpha;
      }
    }
  }

  clearRect(x, y, width, height) {
    const previous = this.fillStyle;
    this.fillStyle = "#000";
    this.fillRect(x, y, width, height);
    this.fillStyle = previous;
  }

  drawImage(source, destinationX, destinationY, destinationWidth, destinationHeight) {
    assert.ok(source instanceof FakeCanvas, "the VM fixture only accepts canvas image sources");
    const width = Math.max(0, Math.round(destinationWidth));
    const height = Math.max(0, Math.round(destinationHeight));
    for (let y = 0; y < height; y += 1) {
      const targetY = Math.floor(destinationY + y);
      if (targetY < 0 || targetY >= this.canvas.height) continue;
      const sourceY = Math.min(source.height - 1, Math.floor(y * source.height / Math.max(1, height)));
      for (let x = 0; x < width; x += 1) {
        const targetX = Math.floor(destinationX + x);
        if (targetX < 0 || targetX >= this.canvas.width) continue;
        const sourceX = Math.min(source.width - 1, Math.floor(x * source.width / Math.max(1, width)));
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const targetOffset = (targetY * this.canvas.width + targetX) * 4;
        this.canvas.pixels[targetOffset] = source.pixels[sourceOffset];
        this.canvas.pixels[targetOffset + 1] = source.pixels[sourceOffset + 1];
        this.canvas.pixels[targetOffset + 2] = source.pixels[sourceOffset + 2];
        this.canvas.pixels[targetOffset + 3] = source.pixels[sourceOffset + 3];
      }
    }
  }

  getImageData(x, y, width, height) {
    const result = this.createImageData(width, height);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const sourceX = x + column;
        const sourceY = y + row;
        if (sourceX < 0 || sourceX >= this.canvas.width || sourceY < 0 || sourceY >= this.canvas.height) continue;
        const sourceOffset = (sourceY * this.canvas.width + sourceX) * 4;
        const targetOffset = (row * width + column) * 4;
        result.data.set(this.canvas.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
    return result;
  }

  createImageData(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  putImageData(imageData, x, y) {
    for (let row = 0; row < imageData.height; row += 1) {
      for (let column = 0; column < imageData.width; column += 1) {
        const targetX = x + column;
        const targetY = y + row;
        if (targetX < 0 || targetX >= this.canvas.width || targetY < 0 || targetY >= this.canvas.height) continue;
        const sourceOffset = (row * imageData.width + column) * 4;
        const targetOffset = (targetY * this.canvas.width + targetX) * 4;
        this.canvas.pixels.set(imageData.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
  }
}

class FakeCanvas {
  constructor(width = 300, height = 150) {
    this._width = width;
    this._height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.context = null;
  }

  get width() { return this._width; }
  set width(value) {
    this._width = Number(value);
    this.pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }

  get height() { return this._height; }
  set height(value) {
    this._height = Number(value);
    this.pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }

  getContext(type) {
    assert.equal(type, "2d");
    if (!this.context) this.context = new FakeCanvasContext2D(this);
    return this.context;
  }
}

function createVisionRuntime() {
  const storage = new Map();
  const window = {
    setTimeout,
    clearTimeout,
    location: { href: "http://localhost/" }
  };
  const sandbox = {
    window,
    document: {
      createElement(tagName) {
        assert.equal(tagName, "canvas");
        return new FakeCanvas();
      }
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    console,
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Float32Array,
    Int32Array,
    Map,
    Set,
    Math,
    Date
  };
  vm.createContext(sandbox);
  vm.runInContext(pixelCoreSource, sandbox, { filename: "vision-pixel-core.js" });
  vm.runInContext(visionSource, sandbox, { filename: "vision.js" });
  assert.ok(window.CarVision, "vision.js must publish window.CarVision");
  return {
    vision: window.CarVision,
    pixelCore: window.CarVisionPixelCore,
    createCanvas: () => new FakeCanvas(640, 480)
  };
}

function paintBackground(canvas, color = [18, 28, 42, 255]) {
  for (let offset = 0; offset < canvas.pixels.length; offset += 4) {
    canvas.pixels[offset] = color[0];
    canvas.pixels[offset + 1] = color[1];
    canvas.pixels[offset + 2] = color[2];
    canvas.pixels[offset + 3] = color[3];
  }
}

function paintCircle(canvas, centerX, centerY, radius, color) {
  const radiusSquared = radius * radius;
  for (let y = Math.max(0, centerY - radius); y <= Math.min(canvas.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(canvas.width - 1, centerX + radius); x += 1) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 > radiusSquared) continue;
      const offset = (y * canvas.width + x) * 4;
      canvas.pixels.set(color, offset);
    }
  }
}

function paintRectangle(canvas, x, y, width, height, color) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const offset = (row * canvas.width + column) * 4;
      canvas.pixels.set(color, offset);
    }
  }
}

const virtualOptions = {
  source: "virtual",
  fovDegrees: 60,
  cameraForwardOffset: 0.43,
  // The frozen competition detector deliberately ignores mission-provided
  // class hints and always evaluates all five classes.
  virtualPixelClasses: ["red-ball", "obstacle"]
};

test("analyzeFrame accepts a canvas and classifies red connected regions left, center, and right", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  paintCircle(frame, 100, 240, 28, [235, 35, 30, 255]);
  paintCircle(frame, 320, 240, 28, [235, 35, 30, 255]);
  paintCircle(frame, 540, 240, 28, [235, 35, 30, 255]);

  const status = await runtime.vision.analyzeFrame(frame, virtualOptions);
  const redBalls = runtime.vision.getDetections().filter(item => item.label === "红球");

  assert.equal(status.source, "virtual");
  assert.equal(status.detectorVersion, "chenlong.virtual-pixel/v2");
  assert.equal(runtime.vision.detectorVersion, status.detectorVersion);
  assert.equal(status.fresh, true);
  assert.equal(status.ready, true);
  assert.deepEqual(Array.from(redBalls, item => item.direction).sort(), ["中间", "右", "左"].sort());
  assert.equal(redBalls.every(item => item.source === "virtual-cv"), true);
  assert.equal(redBalls.every(item => item.category === "target"), true);
  assert.equal(redBalls.every(item => item.detectorVersion === status.detectorVersion), true);
  assert.equal(redBalls.every(item => item.frameId === status.frameId), true);
});

test("virtual ball direction uses the shaded silhouette instead of a one-sided highlight", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  // The simulator's directional light can leave only the right-hand cap above
  // the old bright-color threshold even though the ball itself is centred.
  paintCircle(frame, 320, 240, 90, [72, 18, 20, 255]);
  paintCircle(frame, 382, 240, 22, [235, 35, 30, 255]);

  await runtime.vision.analyzeFrame(frame, virtualOptions);
  const target = runtime.vision.getDetections().find(item => item.category === "target");

  assert.ok(target, "the highlighted shaded ball must remain detectable");
  assert.equal(target.direction, "中间");
  assert.ok(target.box.x <= 232 && target.box.x + target.box.width >= 408,
    "the detection box must cover the shaded silhouette, not only the bright cap");
});

test("virtual distractor direction also uses its shaded silhouette", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  paintCircle(frame, 320, 240, 90, [25, 48, 96, 255]);
  paintCircle(frame, 382, 240, 22, [59, 130, 246, 255]);

  await runtime.vision.analyzeFrame(frame, virtualOptions);
  const distractor = runtime.vision.getDetections().find(item => item.category === "distractor");

  assert.ok(distractor);
  assert.equal(distractor.direction, "中间");
  assert.ok(distractor.box.x <= 232 && distractor.box.x + distractor.box.width >= 408);
});

test("virtual distractor stays separate from a touching blue-gray road", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  // These road pixels become approximately [46, 73, 96] after the detector's
  // contrast expansion, matching the real WebGL training frame that exposed
  // the former giant connected component.
  paintBackground(frame, [55, 79, 99, 255]);
  paintCircle(frame, 320, 260, 72, [27, 75, 164, 255]);
  paintCircle(frame, 350, 235, 24, [69, 130, 243, 255]);

  await runtime.vision.analyzeFrame(frame, virtualOptions);
  const distractors = runtime.vision.getDetections().filter(item => item.category === "distractor");

  assert.equal(distractors.length, 1);
  assert.equal(distractors[0].direction, "中间");
  assert.ok(distractors[0].box.width < 180,
    "the blue-gray road must not merge into the distractor component");
});

test("shaded virtual colors require a connected bright seed", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  paintCircle(frame, 100, 240, 50, [72, 18, 20, 255]);
  paintCircle(frame, 210, 240, 50, [25, 48, 96, 255]);
  // This dark-red U surrounds, but does not touch, a small bright-red object.
  // Its bounding box must not borrow the disconnected object's bright seed.
  paintRectangle(frame, 280, 150, 20, 180, [72, 18, 20, 255]);
  paintRectangle(frame, 480, 150, 20, 180, [72, 18, 20, 255]);
  paintRectangle(frame, 280, 150, 220, 20, [72, 18, 20, 255]);
  paintCircle(frame, 390, 240, 20, [235, 35, 30, 255]);

  await runtime.vision.analyzeFrame(frame, virtualOptions);
  const detections = runtime.vision.getDetections();
  const targets = detections.filter(item => item.category === "target");

  assert.equal(detections.some(item => item.category === "distractor"), false);
  assert.equal(targets.length, 1);
  assert.ok(targets[0].box.width < 60, "the disconnected dark surround must not expand the bright object");
});

test("analyzeFrame classifies a yellow horizontal band as a centered obstacle", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  paintRectangle(frame, 250, 250, 140, 20, [235, 185, 25, 255]);

  const status = await runtime.vision.analyzeFrame(frame, virtualOptions);
  const obstacles = runtime.vision.getDetections().filter(item => item.label === "障碍物");

  assert.equal(status.source, "virtual");
  assert.equal(obstacles.length, 1);
  assert.equal(obstacles[0].category, "obstacle");
  assert.equal(obstacles[0].direction, "中间");
  assert.equal(obstacles[0].source, "virtual-cv");
  assert.equal(Number.isFinite(obstacles[0].distance), true);
});

test("the frozen virtual detector classifies target, obstacle, distractor, storage, and cleanup pixels together", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  paintCircle(frame, 80, 180, 24, [235, 35, 30, 255]);
  paintCircle(frame, 205, 180, 24, [150, 55, 220, 255]);
  paintRectangle(frame, 270, 180, 120, 18, [235, 185, 25, 255]);
  paintRectangle(frame, 440, 130, 28, 82, [30, 200, 80, 255]);
  paintRectangle(frame, 535, 130, 28, 82, [235, 105, 25, 255]);

  const status = await runtime.vision.analyzeFrame(frame, {
    ...virtualOptions,
    virtualPixelClasses: [],
    useYolo: true
  });
  const detections = runtime.vision.getDetections();
  const byCategory = new Map(Array.from(detections, item => [item.category, item]));

  assert.equal(status.detectorVersion, "chenlong.virtual-pixel/v2");
  assert.deepEqual(
    Array.from(byCategory.keys()).sort(),
    ["cleanup-zone", "distractor", "obstacle", "storage-zone", "target"].sort()
  );
  assert.equal(byCategory.get("target").label, "红球");
  assert.equal(byCategory.get("obstacle").label, "障碍物");
  assert.equal(byCategory.get("distractor").label, "混淆物");
  assert.equal(byCategory.get("storage-zone").label, "存放点");
  assert.equal(byCategory.get("cleanup-zone").label, "清理点");
  ["target", "obstacle", "distractor", "storage-zone", "cleanup-zone"].forEach(category => {
    assert.equal(detections.filter(item => item.category === category).length, 1,
      `${category} pixels must not leak into another official class`);
  });
  assert.equal(detections.every(item => item.detectorVersion === status.detectorVersion), true);
  assert.equal(status.loading, false, "virtual mode must not start YOLO even when useYolo is requested");
  assert.equal(status.modelError, "");

  const summarize = items => items.map(item => ({
    category: item.category,
    label: item.label,
    confidence: Number(item.confidence.toFixed(6)),
    distance: Number(item.distance.toFixed(6)),
    clearance: Number.isFinite(item.clearance) ? Number(item.clearance.toFixed(6)) : null,
    near: item.near,
    minimumApproachDistance: item.minimumApproachDistance ?? null,
    direction: item.direction,
    box: item.box
  }));
  const directFrame = runtime.pixelCore.prepareVirtualFrame(frame.pixels);
  const direct = runtime.pixelCore.detectVirtualPixels(directFrame, virtualOptions);
  const browserResult = JSON.parse(JSON.stringify(summarize(detections)));
  const directResult = JSON.parse(JSON.stringify(summarize(direct)));
  const golden = [
    { category: "target", label: "红球", confidence: 0.891111, distance: 4.83, clearance: 4.11, near: false, minimumApproachDistance: 0.725, direction: "左", box: { x: 56, y: 236, width: 48, height: 48 } },
    { category: "distractor", label: "混淆物", confidence: 0.880145, distance: 4.555537, clearance: 3.835537, near: false, minimumApproachDistance: 0.725, direction: "左", box: { x: 182, y: 236, width: 46, height: 48 } },
    { category: "storage-zone", label: "存放点", confidence: 0.92, distance: 6.357406, clearance: null, near: false, minimumApproachDistance: 1.08, direction: "右", box: { x: 440, y: 210, width: 28, height: 82 } },
    { category: "cleanup-zone", label: "清理点", confidence: 0.92, distance: 6.864403, clearance: null, near: false, minimumApproachDistance: 1.08, direction: "右", box: { x: 534, y: 210, width: 28, height: 82 } },
    { category: "obstacle", label: "障碍物", confidence: 0.92, distance: 2.023948, clearance: 1.063948, near: false, minimumApproachDistance: null, direction: "中间", box: { x: 244, y: 206, width: 173, height: 90 } }
  ];
  assert.deepEqual(browserResult, golden, "the browser runtime must preserve the frozen five-class golden result");
  assert.deepEqual(directResult, golden, "the shared core must match the browser runtime exactly");
});

test("near vertical zone signs remain detectable when clipped by the camera frame", async () => {
  for (const [category, color] of [
    ["storage-zone", [30, 200, 80, 255]],
    ["cleanup-zone", [235, 105, 25, 255]]
  ]) {
    const runtime = createVisionRuntime();
    const frame = runtime.createCanvas();
    paintBackground(frame);
    // A close sign fills the full 480 px source height. After 640-square
    // letterboxing it touches both content boundaries and is 75% of the model.
    paintRectangle(frame, 220, 0, 200, 480, color);

    await runtime.vision.analyzeFrame(frame, virtualOptions);
    const zone = runtime.vision.getDetections().find(item => item.category === category);

    assert.ok(zone, `${category} must survive vertical boundary clipping`);
    assert.equal(zone.direction, "中间");
    assert.ok(zone.box.height >= 476);
    assert.equal(zone.near, true);
  }
});

test("a centered zone remains visible at the 80 cm approach threshold", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  // A 420 px-wide 38 cm marker corresponds to roughly 80 cm after adding the
  // robot camera's 43 cm forward offset. It is intentionally clipped at the
  // top and bottom, as it is in the real training scene.
  paintRectangle(frame, 110, 0, 420, 480, [30, 200, 80, 255]);

  await runtime.vision.analyzeFrame(frame, virtualOptions);
  const zone = runtime.vision.getDetections().find(item => item.category === "storage-zone");

  assert.ok(zone, "the close centered zone must not disappear before approach reaches 80 cm");
  assert.equal(zone.direction, "中间");
  assert.ok(zone.distance >= 0.75 && zone.distance <= 0.86,
    `expected a calibrated close distance, received ${zone.distance}`);
});

test("boundary clipping does not turn a large flat color field into a zone", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  paintRectangle(frame, 0, 0, 320, 480, [30, 200, 80, 255]);

  await runtime.vision.analyzeFrame(frame, virtualOptions);

  assert.equal(runtime.vision.getDetections().some(item => item.category === "storage-zone"), false);
});

test("a full-width color field is not accepted as a zone", async () => {
  for (const [category, color] of [
    ["storage-zone", [30, 200, 80, 255]],
    ["cleanup-zone", [235, 105, 25, 255]]
  ]) {
    const runtime = createVisionRuntime();
    const frame = runtime.createCanvas();
    paintBackground(frame);
    paintRectangle(frame, 0, 0, 640, 480, color);

    await runtime.vision.analyzeFrame(frame, virtualOptions);

    assert.equal(runtime.vision.getDetections().some(item => item.category === category), false,
      `${category} must reject a field touching both horizontal edges`);
  }
});

test("a boundary decoration band is not accepted as a clipped zone sign", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  paintRectangle(frame, 220, 0, 200, 40, [30, 200, 80, 255]);

  await runtime.vision.analyzeFrame(frame, virtualOptions);

  assert.equal(runtime.vision.getDetections().some(item => item.category === "storage-zone"), false);
});

test("virtual distractor and zone detectors reject tiny or wrong-shape color patches", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  paintRectangle(frame, 60, 100, 110, 8, [150, 55, 220, 255]);
  paintRectangle(frame, 230, 100, 100, 16, [30, 200, 80, 255]);
  paintCircle(frame, 420, 150, 24, [235, 105, 25, 255]);
  paintRectangle(frame, 520, 100, 6, 10, [150, 55, 220, 255]);
  paintCircle(frame, 580, 180, 22, [65, 90, 120, 255]);

  await runtime.vision.analyzeFrame(frame, virtualOptions);
  const categories = Array.from(runtime.vision.getDetections(), item => item.category);

  assert.equal(categories.includes("distractor"), false);
  assert.equal(categories.includes("storage-zone"), false);
  assert.equal(categories.includes("cleanup-zone"), false);
});

test("cleanup markers suppress overlapping red-target and yellow-obstacle aliases", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);
  paintRectangle(frame, 300, 150, 32, 96, [235, 105, 25, 255]);
  paintRectangle(frame, 300, 182, 32, 32, [190, 80, 20, 255]);
  paintRectangle(frame, 310, 190, 12, 12, [150, 55, 220, 255]);

  await runtime.vision.analyzeFrame(frame, virtualOptions);
  const categories = Array.from(runtime.vision.getDetections(), item => item.category);

  assert.deepEqual(categories, ["cleanup-zone"]);
});

test("analyzeFrame does not invent objects in an empty virtual-camera frame", async () => {
  const runtime = createVisionRuntime();
  const frame = runtime.createCanvas();
  paintBackground(frame);

  const status = await runtime.vision.analyzeFrame(frame, virtualOptions);

  assert.equal(status.source, "virtual");
  assert.deepEqual(Array.from(runtime.vision.getDetections()), []);
});

test("analyzeFrame assigns strictly increasing virtual frame ids", async () => {
  const runtime = createVisionRuntime();
  const empty = runtime.createCanvas();
  paintBackground(empty);
  const red = runtime.createCanvas();
  paintBackground(red);
  paintCircle(red, 320, 240, 24, [235, 35, 30, 255]);

  const first = await runtime.vision.analyzeFrame(empty, virtualOptions);
  const second = await runtime.vision.analyzeFrame(red, virtualOptions);
  const third = await runtime.vision.analyzeFrame(empty, virtualOptions);

  assert.ok(first.frameId < second.frameId && second.frameId < third.frameId);
  assert.deepEqual([first.source, second.source, third.source], ["virtual", "virtual", "virtual"]);
});
