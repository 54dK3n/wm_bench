const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const coreSource = fs.readFileSync(path.join(root, "vision-pixel-core.js"), "utf8");
const core = require("../vision-pixel-core.js");
const { canonicalSha256 } = require("../backend/canonical-json.js");

test("virtual vision definitions are immutable and match their canonical SHA-256 constants", () => {
  assert.equal(canonicalSha256(core.CAMERA_DEFINITION), core.CAMERA_DEFINITION_HASH);
  assert.equal(canonicalSha256(core.DETECTOR_DEFINITION), core.DETECTOR_DEFINITION_HASH);
  assert.equal(canonicalSha256(core.QUERY_DEFINITION), core.QUERY_DEFINITION_HASH);
  assert.equal(canonicalSha256(core.VISION_DEFINITION), core.VISION_DEFINITION_HASH);
  assert.equal(core.DETECTOR_VERSION, "chenlong.virtual-pixel/v2");
  assert.equal(core.CAMERA_DEFINITION.verticalFovDegrees, 60);
  assert.equal(core.CAMERA_DEFINITION.cameraForwardOffsetMeters, 0.43);
  assert.deepEqual(core.CAMERA_DEFINITION.mountPositionMeters, { x: 0, y: 0.54, z: -0.43 });
  assert.equal(core.CAMERA_DEFINITION.mountPitchDegrees, -8);
  assert.equal(core.CAMERA_DEFINITION.nearMeters, 0.04);
  assert.equal(core.CAMERA_DEFINITION.farMeters, 30);
  assert.equal(Object.isFrozen(core.CAMERA_DEFINITION), true);
  assert.equal(Object.isFrozen(core.DETECTOR_DEFINITION.classes), true);
  assert.equal(Object.isFrozen(core.QUERY_DEFINITION.categoryLabels), true);
});

test("prepareVirtualFrame reproduces the fixed black letterbox, source-over alpha, and contrast", () => {
  const source = new Uint8ClampedArray(640 * 480 * 4);
  source.set([200, 100, 50, 128], 0);
  source.set([255, 255, 255, 255], 4);
  const frame = core.prepareVirtualFrame(source, { frameId: 4, capturedAt: 9 });

  assert.equal(frame.rgba.length, 640 * 640 * 4);
  assert.deepEqual(Array.from(frame.rgba.subarray(0, 4)), [0, 0, 0, 255]);
  const firstSourcePixel = (80 * 640) * 4;
  assert.deepEqual(Array.from(frame.rgba.subarray(firstSourcePixel, firstSourcePixel + 4)), [97, 41, 13, 255]);
  assert.deepEqual(Array.from(frame.rgba.subarray(firstSourcePixel + 4, firstSourcePixel + 8)), [255, 255, 255, 255]);
  assert.equal(frame.scale, 1);
  assert.equal(frame.padX, 0);
  assert.equal(frame.padY, 80);
  assert.equal(frame.frameId, 4);
  assert.equal(frame.capturedAt, 9);
  assert.throws(() => core.prepareVirtualFrame(new Uint8Array(4)), /exactly 1228800 RGBA bytes/);
});

test("the UMD build publishes the same frozen API to a browser window", () => {
  const sandbox = {
    window: {},
    Uint8Array,
    Uint8ClampedArray,
    Float32Array,
    Int32Array,
    ArrayBuffer,
    Object,
    Math,
    Number,
    String,
    TypeError,
    RangeError
  };
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox, { filename: "vision-pixel-core.js" });
  const browserCore = sandbox.window.CarVisionPixelCore;

  assert.ok(browserCore);
  assert.equal(browserCore.DETECTOR_VERSION, core.DETECTOR_VERSION);
  assert.equal(browserCore.CAMERA_DEFINITION_HASH, core.CAMERA_DEFINITION_HASH);
  assert.equal(browserCore.DETECTOR_DEFINITION_HASH, core.DETECTOR_DEFINITION_HASH);
  assert.equal(browserCore.QUERY_DEFINITION_HASH, core.QUERY_DEFINITION_HASH);
  assert.equal(browserCore.VISION_DEFINITION_HASH, core.VISION_DEFINITION_HASH);
  assert.equal(typeof browserCore.prepareVirtualFrame, "function");
  assert.equal(typeof browserCore.detectVirtualPixels, "function");
  assert.equal(typeof browserCore.projectQuery, "function");
});

test("projectQuery deterministically projects one detector frame into the public query results", () => {
  const detections = [
    {
      label: "红球", category: "target", aliases: ["球", "目标物"], confidence: 0.891,
      distance: 1.234, near: true, stable: true, direction: "中间"
    },
    {
      label: "障碍物", category: "obstacle", aliases: ["障碍", "方块"], confidence: 0.92,
      distance: 2, clearance: 1.04, near: false, stable: true, direction: "中间"
    }
  ];

  assert.equal(core.projectQuery("sees", ["红球", 0.6], detections), true);
  assert.equal(core.projectQuery("count", ["目标物", 0.6], detections), 1);
  assert.equal(core.projectQuery("direction", ["球", 0.6], detections), "中间");
  assert.equal(core.projectQuery("distance_to", ["红球", 0.6], detections), 15);
  assert.equal(core.projectQuery("sees", ["障碍物", 0.6], detections), false,
    "a centered but distant obstacle must not be projected as an avoidance hit");
  assert.deepEqual(core.projectQuery("observe", ["目标物", 0.6], detections), [{
    category: "target",
    categoryLabel: "目标物",
    name: "红球",
    label: "红球",
    direction: "中间",
    distanceCm: 15,
    confidence: 0.89,
    near: true,
    stable: true
  }]);
});

test("projectQuery is the single browser/server contract for unfiltered ordering, aliases, obstacles, and confidence", () => {
  const target = {
    label: "红球", category: "target", aliases: ["球", "包裹", "目标物", "sports ball"],
    confidence: 0.94, distance: 6.53, near: false, stable: true, direction: "中间"
  };
  const distractor = {
    label: "混淆物", category: "distractor", aliases: ["干扰物", "诱饵", "distractor"],
    confidence: 0.9199999999999999, distance: 5.13, near: false, stable: true, direction: "左"
  };
  const farObstacle = {
    label: "障碍物", category: "obstacle", aliases: ["障碍", "方块", "墙"],
    confidence: 0.92, distance: 3.63, clearance: 0.800001, near: false, stable: true, direction: "中间"
  };
  const storage = {
    label: "存放点", category: "storage-zone", aliases: ["存放区", "放置点", "storage zone"],
    confidence: 0.81, distance: 2, near: false, stable: true, direction: "右"
  };
  // Detector order is class order, whereas public results are deliberately
  // sorted. The two 0.92 display values retain their raw-confidence order.
  const detections = [target, distractor, farObstacle, storage];
  const detected = core.projectQuery("detect", [null, 0.6], detections);
  assert.deepEqual(detected.map(item => item["名称"]), ["红球", "障碍物", "混淆物", "存放点"]);
  assert.deepEqual(detected.map(item => item["置信度"]), [0.94, 0.92, 0.92, 0.81]);

  const observed = core.projectQuery("observe", [null, 0.6], detections);
  assert.deepEqual(observed.map(item => item.category), ["target", "obstacle", "distractor", "storage-zone"]);
  assert.deepEqual(Object.keys(observed[0]), [
    "category", "categoryLabel", "name", "label", "direction", "distanceCm", "confidence", "near", "stable"
  ]);
  assert.equal(Object.hasOwn(observed[0], "box"), false);
  assert.equal(Object.hasOwn(observed[0], "aliases"), false);

  assert.equal(core.projectQuery("sees", ["障碍物", 0.6], [farObstacle]), false);
  assert.equal(core.projectQuery("sees", ["墙", 0.6], [{ ...farObstacle, clearance: 0.8 }]), true);
  assert.equal(core.projectQuery("sees", ["纸箱", 0.6], [target]), true);
  assert.equal(core.projectQuery("count", ["干扰物", 0.92], [distractor]), 0,
    "confidence filtering uses the raw score before two-decimal display rounding");
  assert.equal(core.projectQuery("count", ["distractor", 0.919], [distractor]), 1);
  assert.equal(core.projectQuery("direction", ["storage_zone", 0.6], [storage]), "右");
});

test("the detector uses the frozen camera calibration and rejects conflicting runtime values", () => {
  const source = new Uint8ClampedArray(640 * 480 * 4);
  const frame = core.prepareVirtualFrame(source);
  assert.deepEqual(core.detectVirtualPixels(frame), []);
  assert.throws(
    () => core.detectVirtualPixels(frame, { fovDegrees: 61, cameraForwardOffset: 0.43 }),
    /fovDegrees must equal the frozen 60/
  );
  assert.throws(
    () => core.detectVirtualPixels(frame, { fovDegrees: 60, cameraForwardOffset: 0.4 }),
    /cameraForwardOffset must equal the frozen 0.43/
  );
});
