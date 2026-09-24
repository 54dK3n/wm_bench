const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const { loadPyodide } = require(path.join(root, "vendor", "pyodide", "pyodide.js"));
const workerSource = fs.readFileSync(path.join(root, "python-worker.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const runtimeMatch = workerSource.match(/const runtime = (`[\s\S]*?`);[\s\S]*?await pyodide\.runPythonAsync\(runtime\)/);

function trainingExampleSource(id) {
  const marker = `"${id}": \``;
  const start = appSource.indexOf(marker);
  assert.ok(start >= 0, `${id} example should exist`);
  const sourceStart = start + marker.length;
  const sourceEnd = appSource.indexOf("`", sourceStart);
  assert.ok(sourceEnd > sourceStart, `${id} example should be a template string`);
  return appSource.slice(sourceStart, sourceEnd);
}

test("robot.observe and robot.holding normalize JSON results and strictly validate parameters", async () => {
  assert.ok(runtimeMatch, "python-worker runtime template should be extractable");
  let runtime;
  assert.doesNotThrow(() => {
    runtime = vm.runInNewContext(runtimeMatch[1]);
  }, "the worker runtime must survive JavaScript template-literal evaluation");
  const runtimeRoot = path.join(root, "vendor", "pyodide") + path.sep;
  const pyodide = await loadPyodide({
    indexURL: runtimeRoot,
    stdLibURL: path.join(runtimeRoot, "python_stdlib.zip")
  });
  const calls = [];
  const holdingCalls = [];
  const holdingResponses = ['"target-a"', "null"];
  const actionCalls = [];
  const navigationCalls = [];
  const navigationControlCalls = [];
  const exampleObservationCounts = new Map();
  let exampleMode = "";
  pyodide.globals.set("js_robot", {
    observe: async (category, confidence) => {
      const normalizedCategory = category == null ? null : String(category);
      calls.push([normalizedCategory, Number(confidence)]);
      if (!exampleMode) return "[]";
      const count = (exampleObservationCounts.get(normalizedCategory) || 0) + 1;
      exampleObservationCounts.set(normalizedCategory, count);
      return JSON.stringify([{ category: normalizedCategory, direction: "中间", distanceCm: 120 }]);
    },
    holding: async (...args) => {
      holdingCalls.push(args);
      if (exampleMode === "training-target") return '"目标物"';
      if (exampleMode === "training-distractor") return '"混淆物"';
      return holdingResponses.shift() ?? "null";
    },
    odometry: async (...args) => {
      navigationCalls.push(["odometry", ...args]);
      return JSON.stringify({ forwardCm: 125, rightCm: -8, headingDeg: 12.5, distanceCm: 140, tick: 70 });
    },
    road_state: async (...args) => {
      navigationCalls.push(["road_state", ...args]);
      return JSON.stringify({
        onRoad: true,
        roadId: "north-west-main",
        roadIds: ["north-west-main"],
        lateralOffsetCm: -8,
        headingErrorDeg: 4.2,
        leftClearanceCm: 59,
        rightClearanceCm: 75,
        atJunction: false,
        tick: 70
      });
    },
    map_graph: async (...args) => {
      navigationCalls.push(["map_graph", ...args]);
      return JSON.stringify({
        schemaVersion: "chenlong.road-graph/v1",
        nodes: [
          { nodeId: "node:north-west-main:start", roadIds: ["north-west-main"] },
          { nodeId: "node:north-west-main:end", roadIds: ["north-west-main"] }
        ],
        edges: [{
          roadId: "north-west-main",
          fromNodeId: "node:north-west-main:start",
          toNodeId: "node:north-west-main:end",
          lengthCm: 1200,
          oneWay: false
        }]
      });
    },
    mission: async (...args) => {
      navigationCalls.push(["mission", ...args]);
      return JSON.stringify({
        schemaVersion: "chenlong.navigation-mission/v1",
        mapId: "guangyang-island",
        mapVersion: "revision-4",
        start: { id: "start", roadId: "parking-connector", progressCm: 0 },
        storage: { id: "storage", roadId: "nw-bag", progressCm: 80 },
        checkpoints: [{ id: "checkpoint-1", roadId: "central-north", progressCm: 110 }],
        return: { id: "return", roadId: "parking-connector", progressCm: 0 }
      });
    },
    task_state: async (...args) => {
      navigationCalls.push(["task_state", ...args]);
      return JSON.stringify({
        schemaVersion: "chenlong.task-state/v1",
        completed: 2,
        total: 8,
        status: "running",
        nextCheckpointId: "checkpoint-2",
        targetDelivered: true,
        distractorCleared: false,
        avoidanceStatus: "pending",
        goalReached: false,
        tick: 70
      });
    },
    release_preview: async (...args) => {
      navigationCalls.push(["release_preview", ...args]);
      return JSON.stringify({
        schemaVersion: "chenlong.release-preview/v1",
        holding: "distractor",
        releaseAccepted: true,
        releaseReason: "ready",
        wouldCompleteDelivery: true,
        roadClearanceCm: 31,
        requiredRoadClearanceCm: 20,
        tick: 70
      });
    },
    follow_road: async (maxCm, speed) => {
      const normalizedMaxCm = Number(maxCm);
      const normalizedSpeed = Number(speed);
      navigationControlCalls.push(["follow_road", normalizedMaxCm, normalizedSpeed]);
      return JSON.stringify({
        accepted: true,
        stoppedBy: "max_distance",
        roadId: "north-west-main",
        distanceCm: normalizedMaxCm,
        elapsedTicks: Math.round(normalizedMaxCm / normalizedSpeed * 50)
      });
    },
    take_exit: async (roadId, speed, obeySpeedLimit) => {
      const normalizedRoadId = String(roadId);
      navigationControlCalls.push(["take_exit", normalizedRoadId, Number(speed), Boolean(obeySpeedLimit)]);
      return JSON.stringify({
        accepted: true,
        stoppedBy: "entered_road",
        roadId: normalizedRoadId,
        distanceCm: 25,
        elapsedTicks: 20
      });
    },
    approach: async (...args) => {
      actionCalls.push(["approach", ...args]);
      return "true";
    },
    grab: async () => actionCalls.push(["grab"]),
    release: async () => actionCalls.push(["release"]),
    forward: async (...args) => actionCalls.push(["forward", ...args]),
    backward: async (...args) => actionCalls.push(["backward", ...args]),
    left: async (...args) => actionCalls.push(["left", ...args]),
    right: async (...args) => actionCalls.push(["right", ...args]),
    left_90: async () => actionCalls.push(["left_90"]),
    right_90: async () => actionCalls.push(["right_90"]),
    left_angle: async (...args) => actionCalls.push(["left_angle", ...args]),
    right_angle: async (...args) => actionCalls.push(["right_angle", ...args]),
    wait: async (...args) => actionCalls.push(["wait", ...args])
  });
  pyodide.globals.set("emit_output", () => {});

  async function execute(source) {
    pyodide.globals.set("student_source", source);
    return pyodide.runPythonAsync(runtime, { filename: "<observe-api-test>" });
  }

  await execute([
    "robot.observe()",
    "robot.observe('混淆物', 0.75)",
    "robot.observe('storage_zone', 0)",
    "robot.observe('清理点', 1)"
  ].join("\n"));
  assert.deepEqual(calls, [
    [null, 0.6],
    ["distractor", 0.75],
    ["storage-zone", 0],
    ["cleanup-zone", 1]
  ]);

  await execute('print("browser-e2e-vision", robot.observe("目标物"))');
  assert.deepEqual(calls.at(-1), ["target", 0.6],
    "a nested observe call must retain its category through the automatic-await transform");

  await assert.rejects(execute("robot.observe('unknown')"), /不支持的视觉类别/);
  await assert.rejects(execute("robot.observe(123)"), /视觉类别必须是/);
  await assert.rejects(execute("robot.observe('target', True)"), /置信度必须是/);
  await assert.rejects(execute("robot.observe('obstacle', 1.01)"), /置信度必须是 0 到 1/);
  assert.equal(calls.length, 5, "invalid parameters must be rejected before reaching JavaScript");

  await execute([
    "assert robot.holding() == 'target-a'",
    "assert robot.holding() is None"
  ].join("\n"));
  assert.deepEqual(holdingCalls, [[], []]);
  await assert.rejects(execute("robot.holding('unexpected')"), /positional argument/);
  assert.equal(holdingCalls.length, 2, "holding arguments must be rejected before reaching JavaScript");

  await execute([
    "mission = robot.mission()",
    "progress = robot.task_state()",
    "preview = robot.release_preview()",
    "pose = robot.odometry()",
    "road = robot.road_state()",
    "graph = robot.map_graph()",
    "assert mission['storage']['roadId'] == 'nw-bag'",
    "assert progress['targetDelivered'] is True",
    "assert preview['wouldCompleteDelivery'] is True",
    "assert preview['roadClearanceCm'] == 31",
    "assert pose['forwardCm'] == 125",
    "assert pose['rightCm'] == -8",
    "assert road['onRoad'] is True",
    "assert road['roadId'] == 'north-west-main'",
    "assert graph['schemaVersion'] == 'chenlong.road-graph/v1'",
    "assert graph['nodes'][0]['roadIds'] == ['north-west-main']",
    "assert graph['edges'][0]['lengthCm'] == 1200",
    "assert graph['edges'][0]['oneWay'] is False"
  ].join("\n"));
  assert.deepEqual(navigationCalls, [["mission"], ["task_state"], ["release_preview"], ["odometry"], ["road_state"], ["map_graph"]]);
  await assert.rejects(execute("robot.mission(1)"), /positional argument/);
  await assert.rejects(execute("robot.task_state('x')"), /positional argument/);
  await assert.rejects(execute("robot.release_preview('x')"), /positional argument/);
  await assert.rejects(execute("robot.odometry(1)"), /positional argument/);
  await assert.rejects(execute("robot.road_state('x')"), /positional argument/);
  await assert.rejects(execute("robot.map_graph('x')"), /positional argument/);
  assert.equal(navigationCalls.length, 6, "navigation arguments must be rejected before reaching JavaScript");

  await execute([
    "default_follow = robot.follow_road()",
    "minimum_follow = robot.follow_road(10, 10)",
    "maximum_follow = robot.follow_road(500, 100)",
    "exit_result = robot.take_exit('  east-connector  ')",
    "safe_exit = robot.take_exit(' safe-exit ', 100, True)",
    "minimum_exit = robot.take_exit(' x ')",
    "maximum_exit = robot.take_exit('r' * 128)",
    "assert isinstance(default_follow, dict)",
    "assert default_follow['distanceCm'] == 100",
    "assert minimum_follow['distanceCm'] == 10",
    "assert maximum_follow['distanceCm'] == 500",
    "assert isinstance(exit_result, dict)",
    "assert exit_result['roadId'] == 'east-connector'",
    "assert safe_exit['roadId'] == 'safe-exit'",
    "assert minimum_exit['roadId'] == 'x'",
    "assert len(maximum_exit['roadId']) == 128"
  ].join("\n"));
  assert.deepEqual(navigationControlCalls, [
    ["follow_road", 100, 40],
    ["follow_road", 10, 10],
    ["follow_road", 500, 100],
    ["take_exit", "east-connector", 30, false],
    ["take_exit", "safe-exit", 100, true],
    ["take_exit", "x", 30, false],
    ["take_exit", "r".repeat(128), 30, false]
  ]);

  const invalidNavigationControls = [
    ["robot.follow_road(True)", /\u6700\u5927\u8ddf\u968f\u8ddd\u79bb/],
    ["robot.follow_road('100')", /\u6700\u5927\u8ddf\u968f\u8ddd\u79bb/],
    ["robot.follow_road(float('nan'))", /\u6700\u5927\u8ddf\u968f\u8ddd\u79bb/],
    ["robot.follow_road(float('inf'))", /\u6700\u5927\u8ddf\u968f\u8ddd\u79bb/],
    ["robot.follow_road(9.99)", /\u6700\u5927\u8ddf\u968f\u8ddd\u79bb/],
    ["robot.follow_road(500.01)", /\u6700\u5927\u8ddf\u968f\u8ddd\u79bb/],
    ["robot.follow_road(100, True)", /\u901f\u5ea6/],
    ["robot.follow_road(100, float('nan'))", /\u901f\u5ea6/],
    ["robot.follow_road(100, 9.99)", /\u901f\u5ea6/],
    ["robot.follow_road(100, 100.01)", /\u901f\u5ea6/],
    ["robot.take_exit('x', True)", /\u901f\u5ea6/],
    ["robot.take_exit('x', 9.99)", /\u901f\u5ea6/],
    ["robot.take_exit('x', 100.01)", /\u901f\u5ea6/],
    ["robot.take_exit('x', 30, 'yes')", /出口自动遵守限速选项/],
    ["robot.take_exit(None)", /\u9053\u8def\u7f16\u53f7/],
    ["robot.take_exit(123)", /\u9053\u8def\u7f16\u53f7/],
    ["robot.take_exit('   ')", /\u9053\u8def\u7f16\u53f7/],
    ["robot.take_exit('a' * 129)", /\u9053\u8def\u7f16\u53f7/],
    ["robot.take_exit('bad' + chr(0) + 'road')", /\u9053\u8def\u7f16\u53f7/],
    ["robot.take_exit('bad' + chr(31) + 'road')", /\u9053\u8def\u7f16\u53f7/],
    ["robot.take_exit('bad' + chr(127) + 'road')", /\u9053\u8def\u7f16\u53f7/],
    ["robot.take_exit('bad' + chr(128) + 'road')", /\u9053\u8def\u7f16\u53f7/],
    ["robot.take_exit('bad' + chr(159) + 'road')", /\u9053\u8def\u7f16\u53f7/]
  ];
  for (const [source, errorPattern] of invalidNavigationControls) {
    await assert.rejects(execute(source), errorPattern, source);
  }
  assert.equal(navigationControlCalls.length, 7,
    "invalid navigation-control parameters must be rejected before reaching JavaScript");

  await execute([
    "explicit_follow = await robot.follow_road(25, 20)",
    "assert explicit_follow['distanceCm'] == 25",
    "async def explicit_pose():",
    "    return await robot.odometry()",
    "pose = await explicit_pose()",
    "assert pose['forwardCm'] == 125"
  ].join("\n"));
  assert.deepEqual(navigationControlCalls.at(-1), ["follow_road", 25, 20],
    "an explicit await must not be transformed into a double await");
  assert.deepEqual(navigationCalls.at(-1), ["odometry"],
    "explicitly awaited student helpers must remain usable");

  for (const id of ["training-target", "training-obstacle", "training-distractor"]) {
    exampleMode = id;
    actionCalls.length = 0;
    exampleObservationCounts.clear();
    await execute(trainingExampleSource(id));
    const actionNames = actionCalls.map(call => call[0]);
    if (id === "training-target") {
      assert.deepEqual(actionNames, ["approach", "grab"]);
    } else if (id === "training-obstacle") {
      assert.deepEqual(actionNames, []);
    } else {
      assert.deepEqual(actionNames, ["approach", "grab"]);
      assert.deepEqual(navigationCalls.at(-1), ["road_state"],
        "distractor training should read road clearance through the navigation sensor");
    }
  }
});
