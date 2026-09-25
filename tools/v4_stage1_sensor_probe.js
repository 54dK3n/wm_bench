#!/usr/bin/env node
"use strict";

// Offline boundary probe: real virtual pixel detector -> unchanged browser
// observe adapter. The fake canvas comes from the platform's existing tests.
// No simulation layout, object coordinates, or native task state is used.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const VERSION = "wm-v4-stage1-sensor-probe/v1";
const ROOT = path.resolve(__dirname, "..");
const PLATFORM = path.join(ROOT, "workspaces/guangyang-platform/projects/car-python");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {flag: "wx"});

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, "Usage: node tools/v4_stage1_sensor_probe.js --out <new-directory>");
  assert.equal(args[0], "--out");
  const output = path.resolve(args[1]);
  assert.equal(fs.existsSync(output), false, "Evidence output must be a new directory");
  const sourceNames = ["vision.js", "vision-pixel-core.js", "robot-backend-runtime.js",
    "robot-bridge-contract.js", "storage-region-pixels.js", "tests/vision-runtime.test.js"];
  const sources = Object.fromEntries(sourceNames.map(name => [name, fs.readFileSync(path.join(PLATFORM, name), "utf8")]));
  const fixture = sources["tests/vision-runtime.test.js"];
  const fixtureEnd = fixture.indexOf('\ntest("');
  assert.ok(fixtureEnd > 0, "Fixture prefix not found; do not silently run altered tests");
  const runtimeSource = sources["robot-backend-runtime.js"];
  const observeStart = runtimeSource.indexOf("  async function observe(params)");
  const observeEnd = runtimeSource.indexOf("\n  function localRoad()", observeStart);
  assert.ok(observeStart >= 0 && observeEnd > observeStart, "Unchanged observe adapter not found");
  const observeSource = runtimeSource.slice(observeStart, observeEnd);
  const platformRequire = createRequire(path.join(PLATFORM, "tests/vision-runtime.test.js"));
  const makeFixture = () => new Function("require", "__dirname", fixture.slice(0, fixtureEnd)
    + "\nreturn {runtime:createVisionRuntime(),paintBackground,paintCircle,paintRectangle,virtualOptions};")
    (platformRequire, path.join(PLATFORM, "tests"));
  const contract = require(path.join(PLATFORM, "robot-bridge-contract.js"));
  const storage = require(path.join(PLATFORM, "storage-region-pixels.js"));
  const fixtures = [
    {name: "red-ball", rawCategory: "target", shape: "circle", args: [320, 260, 60, [235, 35, 30, 255]]},
    {name: "blue-ball", rawCategory: "distractor", shape: "circle", args: [320, 260, 60, [59, 130, 246, 255]]},
    {name: "obstacle", rawCategory: "obstacle", shape: "rectangle", args: [250, 250, 140, 20, [235, 185, 25, 255]]},
    {name: "storage-zone", rawCategory: null, shape: "rectangle", args: [200, 320, 240, 100, [0, 255, 0, 255]]}
  ];
  const trials = [];
  for (const input of fixtures) {
    const {runtime, paintBackground, paintCircle, paintRectangle, virtualOptions} = makeFixture();
    const canvas = runtime.createCanvas();
    paintBackground(canvas);
    (input.shape === "circle" ? paintCircle : paintRectangle)(canvas, ...input.args);
    const context = {tick: 0, stepMs: 20, stateRevision: 0, generation: 1};
    runtime.vision.beginVirtualRun({getContext: () => context});
    try {
      await runtime.vision.analyzeFrame(canvas, virtualOptions);
      const pixelDetections = plain(runtime.vision.getDetections());
      const sensorContext = {
        root: {CarVision: runtime.vision, RobotBridgeContract: contract, CarStorageRegionPixels: storage},
        // Capture is already performed above on the recorded pixel fixture.
        startVirtualCameraVision: async () => ({frameId: runtime.vision.getStatus().frameId}),
        addCompetitionVisionQuery() {}, projectSimpleVisionQuery() { return null; },
        virtualCameraContext: canvas.getContext("2d"), tick: () => context.tick
      };
      vm.createContext(sensorContext);
      vm.runInContext(observeSource, sensorContext, {filename: "unchanged-observe-adapter.js"});
      const params = {category: input.name, confidence: 0};
      const rawObservation = await sensorContext.observe(params);
      const bridgeObservation = contract.sanitizeResponse("observe", rawObservation);
      const detectorSawClass = input.rawCategory === null
        ? storage.detectStorageRegions(canvas.getContext("2d").getImageData(0, 0, 640, 480)).length > 0
        : pixelDetections.some(item => item.category === input.rawCategory);
      assert.equal(detectorSawClass, true, `Invalid fixture: detector did not see ${input.name}`);
      trials.push({name: input.name, input: {width: 640, height: 480,
        backgroundRgba: [18, 28, 42, 255], draw: input,
        rgbaSha256: sha(canvas.pixels), virtualOptions, simulationContext: context},
        detectorSawClass, pixelDetections, params, bridgeObservation: plain(bridgeObservation),
        pass: bridgeObservation.detections.some(item => item.category === input.name)});
    } finally { runtime.vision.stop(); }
  }
  const hashes = Object.fromEntries(sourceNames.map(name => [name, sha(sources[name])]));
  const manifest = {version: VERSION, script: {file: path.relative(ROOT, __filename), sha256: sha(fs.readFileSync(__filename))},
    platformRoot: path.relative(ROOT, PLATFORM), platformSourceSha256: hashes,
    adapter: {function: "observe", sourceSha256: sha(observeSource),
      firstLine: runtimeSource.slice(0, observeStart).split("\n").length},
    limitations: ["Offline synthetic RGBA fixtures, not a browser/WebGL simulation acceptance run.",
      "Vision detector and observe adapter are unchanged platform source; only capture readiness and native evaluation logging are test doubles."]};
  const report = {schema: VERSION, allPass: trials.every(trial => trial.pass),
    detectorFixturesValid: trials.every(trial => trial.detectorSawClass),
    passed: trials.filter(trial => trial.pass).length, failed: trials.filter(trial => !trial.pass).length,
    stage1Decision: trials.every(trial => trial.pass) ? "sensor-probe-passed" : "blocked-do-not-enter-stage2",
    manifest, trials};
  fs.mkdirSync(output, {recursive: true});
  write(path.join(output, "sensor-probe.json"), report);
  write(path.join(output, "manifest.json"), manifest);
  console.log(JSON.stringify({out: output, passed: report.passed, failed: report.failed, allPass: report.allPass}));
  process.exitCode = report.allPass ? 0 : 1;
  return report;
}

module.exports = {main, VERSION};
if (require.main === module) main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
