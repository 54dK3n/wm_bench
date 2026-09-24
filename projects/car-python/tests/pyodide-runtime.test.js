const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { loadPyodide } = require(path.join(root, "vendor", "pyodide", "pyodide.js"));

test("vendored Pyodide executes the worker program bridge without network access", async () => {
  const runtimeRoot = path.join(root, "vendor", "pyodide") + path.sep;
  const pyodide = await loadPyodide({
    indexURL: runtimeRoot,
    stdLibURL: path.join(runtimeRoot, "python_stdlib.zip")
  });
  assert.equal(pyodide.runPython("sum(range(101))"), 5050);

  const workerSource = fs.readFileSync(path.join(root, "python-worker.js"), "utf8");
  const runtimeMatch = workerSource.match(/const runtime = `([\s\S]*?)`;\s*try\s*{\s*await pyodide\.runPythonAsync/);
  assert.ok(runtimeMatch, "worker Python runtime template should be extractable");

  const actions = [];
  const output = [];
  pyodide.globals.set("student_source", "robot.forward(25)\nrobot.right_90()\nprint('done')");
  pyodide.globals.set("js_robot", {
    forward: async distanceCm => actions.push(["forward", Number(distanceCm)]),
    right_90: async () => actions.push(["right_90"])
  });
  pyodide.globals.set("emit_output", value => output.push(String(value)));
  await pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-smoke>" });

  assert.deepEqual(actions, [["forward", 25], ["right_90"]]);
  assert.equal(output.length, 1);
  assert.equal(output[0].startsWith("done"), true);

  pyodide.globals.set("student_run_target", "real");
  pyodide.globals.set("student_source", "robot.forward(25)\nrobot.observe('目标物')");
  await assert.rejects(
    () => pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-real-preflight>" }),
    /真实小车没有感知、定位或任务状态回传[\s\S]*robot\.observe\(\)/
  );
  assert.deepEqual(actions, [["forward", 25], ["right_90"]],
    "an unsupported real-car API anywhere in the program must reject before the first movement");

  pyodide.globals.set("student_source", "r = robot\nrobot.forward(25)\nawait r.observe('目标物')");
  await assert.rejects(
    () => pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-real-alias-preflight>" }),
    /真实小车没有感知、定位或任务状态回传[\s\S]*动态使用 robot/
  );
  assert.deepEqual(actions, [["forward", 25], ["right_90"]],
    "aliasing robot must not bypass the real-car preflight before movement");

  pyodide.globals.set("student_source", "robot.forward(25)\nawait js_robot.observe('目标物')");
  await assert.rejects(
    () => pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-real-bridge-preflight>" }),
    /真实小车没有感知、定位或任务状态回传[\s\S]*访问底层或动态接口/
  );
  assert.deepEqual(actions, [["forward", 25], ["right_90"]],
    "the internal JavaScript bridge must be rejected before real movement");

  pyodide.globals.set("student_source", "robot.forward(25)\nr = globals()['robot']\nawait r.observe('目标物')");
  await assert.rejects(
    () => pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-real-globals-preflight>" }),
    /真实小车没有感知、定位或任务状态回传[\s\S]*访问底层或动态接口/
  );
  assert.deepEqual(actions, [["forward", 25], ["right_90"]],
    "dynamic globals access must be rejected before real movement");

  pyodide.globals.set("student_source", "b = __builtins__\ng = b['globals']\nr = g()['robot']\nawait r.forward(25)\nawait r.observe('目标物')");
  await assert.rejects(
    () => pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-real-builtins-preflight>" }),
    /真实小车没有感知、定位或任务状态回传[\s\S]*访问底层或动态接口/
  );
  assert.deepEqual(actions, [["forward", 25], ["right_90"]],
    "the injected builtins namespace must not bypass real-car preflight");

  pyodide.globals.set("student_source", "g = (x for x in [1])\ns = g.gi_frame.f_globals\nr = s['robot']\nawait r.forward(25)\nawait r.observe('目标物')");
  await assert.rejects(
    () => pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-real-frame-preflight>" }),
    /真实小车没有感知、定位或任务状态回传[\s\S]*访问底层或动态接口/
  );
  assert.deepEqual(actions, [["forward", 25], ["right_90"]],
    "frame reflection must not bypass real-car preflight before movement");

  pyodide.globals.set("student_source", "import math\nfor _ in range(2):\n    robot.forward(math.sqrt(625))");
  await pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-real-safe-builtins>" });
  assert.deepEqual(actions.slice(-2), [["forward", 25], ["forward", 25]],
    "safe math and iteration builtins should remain available in real-car mode");
});
