const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.resolve(__dirname, "..", "app.js"), "utf8");

function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing production function ${name}`);
  const remaining = app.slice(start + 1);
  const nextDeclaration = /\n(?:async\s+)?function\s+/.exec(remaining);
  const next = nextDeclaration ? start + 1 + nextDeclaration.index : -1;
  return app.slice(start, next < 0 ? app.length : next);
}

function createElement() {
  return {
    attributes: new Map(),
    children: [],
    className: "",
    dataset: {},
    hidden: false,
    style: {},
    textContent: "",
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
  };
}

function createHarness() {
  const previewDraws = [];
  const previewClears = [];
  const previewTransforms = [];
  const previewContext = {
    clearRect(...args) { previewClears.push(args); },
    drawImage(...args) { previewDraws.push(args); },
    setTransform(...args) { previewTransforms.push(args); }
  };
  const trainingVisionWorkbench = createElement();
  const trainingVisionCanvas = {
    ...createElement(),
    width: 640,
    height: 480,
    getContext(kind) {
      assert.equal(kind, "2d");
      return previewContext;
    }
  };
  const trainingVisionOverlay = createElement();
  const trainingVisionEmpty = createElement();
  const trainingVisionFrameLabel = createElement();
  const trainingVisionStatus = createElement();
  const sourceCanvas = {
    width: 640,
    height: 480,
    getContext() {
      throw new Error("the evidence source canvas must stay read-only");
    }
  };
  const context = vm.createContext({
    GUANGYANG_CM_PER_WORLD_UNIT: 12.5,
    VIRTUAL_CAMERA_WIDTH: 640,
    VIRTUAL_CAMERA_HEIGHT: 480,
    VIRTUAL_VISION_MODEL_SIZE: 640,
    TRAINING_VISION_PREVIEW_MAX_DPR: 2,
    activeMission: {
      environment: "guangyang",
      trainingOnGuangyang: true,
      objectTraining: { type: "target-delivery" }
    },
    document: { createElement },
    normalizeTrainingVisionCategory(value) {
      return ["target", "obstacle", "distractor", "storage-zone", "cleanup-zone"].includes(value)
        ? value
        : null;
    },
    trainingVisionCategoryLabel(category) {
      return {
        target: "目标物",
        obstacle: "障碍物",
        distractor: "混淆物",
        "storage-zone": "存放点",
        "cleanup-zone": "清理点"
      }[category] || "";
    },
    trainingVisionWorkbench,
    trainingVisionCanvas,
    trainingVisionOverlay,
    trainingVisionEmpty,
    trainingVisionFrameLabel,
    trainingVisionStatus,
    window: {
      devicePixelRatio: 2.75,
      CarVision: {
        getStatus() {
          return { source: "virtual", fresh: true, frameId: 7 };
        }
      }
    }
  });
  const sources = [
    "worldUnitsToCm",
    "isObjectTrainingMission",
    "virtualVisionLetterboxTransform",
    "mapVirtualDetectionBoxToSource",
    "trainingVisionDetectionPresentation",
    "clearTrainingVisionWorkbench",
    "syncTrainingVisionWorkbenchVisibility",
    "renderTrainingVisionWorkbenchFrame"
  ].map(functionSource);
  vm.runInContext(`${sources.join("\n")}\n    globalThis.workbenchApi = {
      virtualVisionLetterboxTransform,
      mapVirtualDetectionBoxToSource,
      trainingVisionDetectionPresentation,
      clearTrainingVisionWorkbench,
      renderTrainingVisionWorkbenchFrame
    };`, context, { filename: "training-camera-workbench-harness.js" });
  return {
    api: context.workbenchApi,
    context,
    previewClears,
    previewDraws,
    previewTransforms,
    sourceCanvas,
    trainingVisionCanvas,
    trainingVisionEmpty,
    trainingVisionFrameLabel,
    trainingVisionOverlay,
    trainingVisionStatus,
    trainingVisionWorkbench
  };
}

test("virtual detection boxes undo the 640-square letterbox before overlay placement", () => {
  const { api } = createHarness();
  const transform = api.virtualVisionLetterboxTransform(640, 480, 640);
  assert.deepEqual(JSON.parse(JSON.stringify(transform)), {
    sourceWidth: 640,
    sourceHeight: 480,
    modelSize: 640,
    scale: 1,
    padX: 0,
    padY: 80
  });

  const mapped = api.mapVirtualDetectionBoxToSource(
    { x: 64, y: 128, width: 128, height: 160 },
    640,
    480,
    640
  );
  assert.deepEqual(JSON.parse(JSON.stringify({
    x: mapped.x,
    y: mapped.y,
    width: mapped.width,
    height: mapped.height,
    leftPercent: mapped.leftPercent,
    topPercent: mapped.topPercent,
    widthPercent: mapped.widthPercent
  })), {
    x: 64,
    y: 48,
    width: 128,
    height: 160,
    leftPercent: 10,
    topPercent: 10,
    widthPercent: 20
  });
  assert.ok(Math.abs(mapped.heightPercent - 100 / 3) < 1e-10);
  assert.equal(api.mapVirtualDetectionBoxToSource(
    { x: 20, y: 10, width: 30, height: 20 },
    640,
    480,
    640
  ), null, "a box wholly inside letterbox padding must not be drawn");
  const clipped = api.mapVirtualDetectionBoxToSource(
    { x: -10, y: 70, width: 30, height: 30 },
    640,
    480,
    640
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify({ x: clipped.x, y: clipped.y, width: clipped.width, height: clipped.height })),
    { x: 0, y: 0, width: 20, height: 20 }
  );
});

test("training workbench copies pixels at high DPI and keeps labels in a sibling overlay", () => {
  const harness = createHarness();
  const rendered = harness.api.renderTrainingVisionWorkbenchFrame(harness.sourceCanvas, [{
    frameId: 7,
    category: "target",
    confidence: 0.936,
    distance: 1.234,
    box: { x: 64, y: 128, width: 128, height: 160 },
    id: "ground-truth-id-must-not-render"
  }], 7);

  assert.equal(rendered, true);
  assert.equal(harness.trainingVisionWorkbench.hidden, false);
  assert.equal(harness.trainingVisionWorkbench.dataset.status, "ready");
  assert.equal(harness.trainingVisionWorkbench.dataset.frameId, "7");
  assert.equal(harness.trainingVisionWorkbench.dataset.sceneId, "target-delivery");
  assert.equal(harness.trainingVisionCanvas.width, 1280, "device scale is capped at 2x");
  assert.equal(harness.trainingVisionCanvas.height, 960);
  assert.deepEqual(harness.previewTransforms.at(-1), [2, 0, 0, 2, 0, 0]);
  assert.equal(harness.previewDraws.length, 1);
  assert.equal(harness.previewDraws[0][0], harness.sourceCanvas,
    "the display canvas must copy, not reuse or annotate, the evidence canvas");

  const [box] = harness.trainingVisionOverlay.children;
  assert.ok(box);
  assert.equal(box.dataset.visionBox, "");
  assert.equal(box.dataset.category, "target");
  assert.equal(box.dataset.frameId, "7");
  assert.equal(box.style.left, "10.0000%");
  assert.equal(box.style.top, "10.0000%");
  assert.equal(box.style.width, "20.0000%");
  assert.equal(box.style.height, "33.3333%");
  assert.match(box.children[0].textContent, /目标物.*94%.*15 cm/);
  assert.doesNotMatch(box.children[0].textContent, /ground-truth|id|坐标/i);
  assert.equal(harness.trainingVisionFrameLabel.textContent, "帧 #7");
  assert.match(harness.trainingVisionStatus.textContent, /1 个训练对象/);
  assert.equal(harness.trainingVisionEmpty.hidden, true);
});

test("scene changes and missing frames synchronously clear stale workbench state", () => {
  const harness = createHarness();
  harness.api.renderTrainingVisionWorkbenchFrame(harness.sourceCanvas, [{
    frameId: 7,
    category: "obstacle",
    confidence: 0.8,
    distance: 1,
    box: { x: 100, y: 120, width: 120, height: 180 }
  }], 7);
  assert.equal(harness.trainingVisionOverlay.children.length, 1);

  harness.api.clearTrainingVisionWorkbench("正在重建训练场景");
  assert.equal(harness.trainingVisionWorkbench.dataset.status, "empty");
  assert.equal(harness.trainingVisionWorkbench.dataset.frameId, "");
  assert.equal(harness.trainingVisionOverlay.children.length, 0);
  assert.equal(harness.trainingVisionEmpty.hidden, false);
  assert.equal(harness.trainingVisionFrameLabel.textContent, "等待帧");
  assert.equal(harness.trainingVisionStatus.textContent, "正在重建训练场景");

  harness.context.activeMission = { environment: "guangyang" };
  assert.equal(harness.api.renderTrainingVisionWorkbenchFrame(harness.sourceCanvas, [], 7), false);
  assert.equal(harness.trainingVisionWorkbench.hidden, true,
    "the official competition map must not expose the training camera workbench");
  assert.equal(harness.trainingVisionWorkbench.dataset.frameId, "");
});
