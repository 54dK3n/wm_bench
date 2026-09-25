"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const detector = require("../robot-camera-detector.js");
const pixels = require("../vision-pixel-core.js");
const storage = require("../storage-region-pixels.js");
const contract = require("../robot-bridge-contract.js");

function cameraImage() {
  const data = new Uint8ClampedArray(640 * 480 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([18, 28, 42, 255], offset);
  return { width: 640, height: 480, data };
}
function rectangle(image, x, y, w, h, color) {
  for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
    image.data.set(color, (row * image.width + col) * 4);
  }
}

test("real virtual-cv pixel detections reach the bridge without source or score relabelling", () => {
  for (const [rawCategory, category, box, color] of [
    ["target", "red-ball", [200, 200, 60, 60], [235, 35, 30, 255]],
    ["distractor", "blue-ball", [200, 200, 60, 60], [40, 70, 235, 255]],
    ["obstacle", "obstacle", [250, 280, 100, 20], [240, 200, 30, 255]]
  ]) {
    const image = cameraImage();
    rectangle(image, ...box, color);
    const native = pixels.detectVirtualPixels(pixels.prepareVirtualFrame(image.data, { frameId: 9, capturedAt: 120 }));
    assert.equal(native.length, 1, `${category} fixture must have exactly one raw detection`);
    assert.equal(native[0].category, rawCategory);
    const expected = [{ category, confidence: native[0].confidence,
      bbox: { x: native[0].box.x, y: native[0].box.y - 80, w: native[0].box.width, h: native[0].box.height },
      source: "virtual-cv" }];
    assert.deepEqual(contract.sanitizeResponse("observe", { frameId: 9, tick: 6, width: 640, height: 480,
      detections: detector.detect(native, []) }).detections, expected);
  }
});

test("projection clips padding, preserves ordering, and never reads native range or truth fields", () => {
  const raw = [
    { source: "virtual-cv", category: "target", confidence: 0.897654321, box: { x: 5, y: 70, width: 30, height: 20 } },
    { source: "virtual-cv", category: "obstacle", confidence: 0.92, box: { x: 635, y: 550, width: 20, height: 30 } },
    { source: "virtual-cv", category: "distractor", confidence: 0.82, box: { x: 8, y: 4, width: 10, height: 20 } }
  ];
  for (const item of raw) for (const key of ["objectId", "distance", "bearingDeg", "position", "role"]) {
    Object.defineProperty(item, key, { get() { throw new Error(`unexpected ${key} read`); } });
  }
  assert.deepEqual(detector.detect(raw, []), [
    { category: "red-ball", confidence: 0.897654321, bbox: { x: 5, y: 0, w: 30, h: 10 }, source: "virtual-cv" },
    { category: "obstacle", confidence: 0.92, bbox: { x: 635, y: 470, w: 5, h: 10 }, source: "virtual-cv" }
  ]);
});

test("ground detector provenance is independent and legacy signs/templates cannot masquerade as a region", () => {
  const image = cameraImage();
  rectangle(image, 100, 300, 60, 40, [0, 255, 0, 255]);
  const regions = storage.detectStorageRegions(image);
  const native = ["storage-zone", "cleanup-zone", "constructor"].map(category => ({ source: "virtual-cv", category,
    confidence: .9, box: { x: 100, y: 150, width: 30, height: 50 } }));
  native.push({ ...native[0], source: "teaching", category: "target" });
  assert.deepEqual(detector.detect(native, regions), [{ category: "storage-zone", confidence: 1,
    bbox: { x: 100, y: 300, w: 60, h: 40 }, source: "storage-ground-pixels" }]);
});

test("YOLO colour evidence remains a distinct source", () => {
  const raw = ["red", "blue", null].map(colorClass => ({ source: "yolo", colorClass, category: "obstacle",
    confidence: .81, box: { x: 25, y: 180, width: 40, height: 50 } }));
  const actual = detector.detect(raw, []);
  assert.deepEqual(actual.map(item => item.category), ["red-ball", "blue-ball", "obstacle"]);
  assert.deepEqual(actual.map(item => item.source), ["yolo", "yolo", "yolo"]);
});

test("runtime observe binds unfiltered raw audit and selected bridge result to the same frame/request", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../robot-backend-runtime.js"), "utf8");
  const image = cameraImage();
  rectangle(image, 200, 200, 60, 60, [235, 35, 30, 255]);
  rectangle(image, 100, 300, 60, 40, [0, 255, 0, 255]);
  const native = pixels.detectVirtualPixels(pixels.prepareVirtualFrame(image.data, { frameId: 3, capturedAt: 120 }));
  const audit = [];
  const context = vm.createContext({
    root: { CarVision: { getStatus: () => ({ fresh: true, frameId: 3 }), getDetections: () => native },
      CarStorageRegionPixels: storage, RobotCameraDetector: detector, RobotBridgeContract: contract },
    startVirtualCameraVision: async () => ({ frameId: 3 }),
    virtualCameraContext: { getImageData: () => image },
    tick: () => 6, addCompetitionVisionQuery() {}, projectSimpleVisionQuery: () => [],
    active: { sensorAudit: audit }, clone: value => JSON.parse(JSON.stringify(value))
  });
  vm.runInContext(source.slice(source.indexOf("  async function observe("), source.indexOf("  function localRoad(")), context);
  const actual = JSON.parse(JSON.stringify(await context.observe({ category: "red-ball", confidence: 0 }, "observe_0003")));
  assert.deepEqual(actual.detections.map(item => [item.category, item.source]), [["red-ball", "virtual-cv"]]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].requestId, "observe_0003");
  assert.equal(audit[0].frameId, actual.frameId);
  assert.equal(audit[0].tick, actual.tick);
  assert.deepEqual(audit[0].visionDetections, JSON.parse(JSON.stringify(native)));
  assert.ok(audit[0].storageDetections.length > 0);
  assert.deepEqual(audit[0].robotDetections.map(item => item.category), ["red-ball", "storage-zone"]);
  assert.deepEqual(contract.sanitizeResponse("observe", actual), actual);
});
