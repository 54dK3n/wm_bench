"use strict";

// Exercise the driver's real parsing and process-monitor loop without a robot,
// platform, child interpreter, network request, or machine-local credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {EventEmitter} = require("node:events");
const test = require("node:test");
const vm = require("node:vm");

const driverFile = path.resolve(__dirname, "../autonomous_brain_driver.js");
// A fixed historical source can be injected to retain a reproducible FAIL
// baseline while the working driver is being edited independently.
const sourceFile = process.env.BRAIN_LIMITS_DRIVER_SOURCE || driverFile;
const source = fs.readFileSync(sourceFile, "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(t, {pollAdvanceMs = 1000, samples = [], ignoreTerm = false} = {}) {
  let now = 0, exited = false;
  const signals = [], waits = [], monitors = [], spawns = [], configurations = [];
  const pendingTimers = new Set();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = text => configurations.push(JSON.parse(text));
  const exit = (code, signal) => {
    if (!exited) {exited = true; child.emit("exit", code, signal);}
  };
  child.kill = signal => {
    signals.push(signal);
    if (signal === "SIGKILL" || !ignoreTerm) exit(null, signal);
    return true;
  };
  t.after(() => {for (const timer of pendingTimers) clearImmediate(timer);});

  const fakeFs = {
    mkdirSync() {},
    createWriteStream() {return {write() {}, end(callback) {callback();}};},
  };
  const module = {exports: {}};
  const isolatedRequire = name => {
    if (name === "node:fs") return fakeFs;
    if (name === "node:child_process") return {
      spawn(program, args, options) {
        spawns.push(plain({program, args, options}));
        return child;
      },
      spawnSync() {throw new Error("unexpected real subprocess path");},
    };
    if (name === "./fresh_map05_platform_gate.js") return {
      verifyPreflightGate() {throw new Error("platform must not be started by this test");},
    };
    if (!name.startsWith("node:")) throw new Error(`unexpected dependency: ${name}`);
    return require(name);
  };
  isolatedRequire.main = {};
  const context = vm.createContext({module, exports: module.exports, require: isolatedRequire,
    __filename: driverFile, __dirname: path.dirname(driverFile),
    process: {env: {}, argv: [], stderr: {write() {}}},
    Date: class extends Date {static now() {return now;}},
    setTimeout(callback, ms) {
      const timer = setImmediate(() => {
        pendingTimers.delete(timer);
        waits.push(ms);
        now += ms === 1000 ? pollAdvanceMs : ms;
        callback();
      });
      pendingTimers.add(timer);
      return timer;
    },
  });
  new vm.Script(source, {filename: sourceFile}).runInContext(context);
  const {parseArgs, runBrain} = module.exports;
  const parse = (args = []) => parseArgs(["--out", "/virtual-brain-limits", ...args]);
  const run = async (args = []) => {
    const options = parse(args);
    const result = await runBrain(options, "/virtual-brain-limits/trial",
      {bridgeId: "synthetic-bridge", clientToken: "synthetic-token"},
      "http://robot.invalid", async expression => {
        const sample = samples[monitors.length];
        monitors.push({expression, wallMs: now});
        // Fail closed even if a regression accidentally ignores every guard;
        // the synthetic child exits so a failing test cannot hang forever.
        if (!sample) {exit(97, null); throw new Error("unexpected extra monitor iteration");}
        if (sample.error) throw new Error(sample.error);
        if (sample.exit) exit(0, null);
        return {tick: sample.tick, stepMs: 20, status: sample.status || "running"};
      });
    return plain(result);
  };
  return {parse, run, signals, waits, monitors, spawns, configurations};
}

test("default wall time can cross 7200 seconds and the child still exits naturally", async t => {
  const f = fixture(t, {pollAdvanceMs: 3600000,
    samples: [{tick: 100}, {tick: 200}, {tick: 300, exit: true}]});
  const result = await f.run();
  assert.equal(result.interrupted, null);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(f.signals, []);
  assert.equal(f.parse().wallTimeoutSeconds, 0);
  assert.equal(result.wallSeconds, 10800);
  assert.deepEqual(f.monitors.map(row => row.wallMs), [3600000, 7200000, 10800000]);
  assert.equal(f.monitors.length, f.waits.filter(ms => ms === 1000).length,
    "every live polling iteration still checks simulation state after the old wall deadline");
  assert.ok(f.monitors.every(row => row.expression.includes("deterministicSimulator")
    && row.expression.includes("competitionSession")));
  assert.equal(f.configurations.length, 1);
  assert.equal(f.configurations[0].max_rounds, 200);
  assert.equal(f.configurations[0].max_simulation_seconds, 1200);
  assert.equal(result.capabilityPassed.max_rounds, 200);
  assert.equal(result.capabilityPassed.max_simulation_seconds, 1200);
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(f.spawns[0].args.slice(0, 2), ["-m", "autonomous_brain.run"]);
  assert.deepEqual(f.spawns[0].options.env, {PYTHONUNBUFFERED: "1"});
});

test("explicit zero wall timeout is legal and disables only the wall deadline", async t => {
  const f = fixture(t, {pollAdvanceMs: 7200001, samples: [{tick: 1, exit: true}]});
  const result = await f.run(["--wall-timeout-seconds", "0"]);
  assert.equal(result.interrupted, null);
  assert.equal(result.code, 0);
  assert.equal(f.monitors.length, 1);
  assert.deepEqual(f.signals, []);
});

test("an explicit positive wall timeout still interrupts and cleans up the child", async t => {
  const f = fixture(t, {samples: [{tick: 1}, {tick: 2}]});
  const result = await f.run(["--wall-timeout-seconds", "2.5"]);
  assert.equal(result.interrupted, "driver_wall_timeout");
  assert.equal(result.signal, "SIGTERM");
  assert.deepEqual(f.signals, ["SIGTERM"]);
  assert.equal(f.monitors.length, 2);
  assert.equal(result.wallSeconds, 3);
});

test("simulation monitoring continues below 1200 seconds and stops at 1200", async t => {
  const f = fixture(t, {samples: [{tick: 59999}, {tick: 60000}]});
  const result = await f.run();
  assert.equal(result.interrupted, "simulation_limit_reached");
  assert.equal(f.monitors.length, 2);
  assert.deepEqual(f.signals, ["SIGTERM"]);
});

test("backend stop remains terminal when no wall deadline is enabled", async t => {
  const f = fixture(t, {samples: [{tick: 1}, {tick: 2, status: "finished"}]});
  const result = await f.run();
  assert.equal(result.interrupted, "backend_stopped:finished");
  assert.equal(f.monitors.length, 2);
  assert.deepEqual(f.signals, ["SIGTERM"]);
});

test("monitor errors still terminate the child through the cleanup guard", async t => {
  const f = fixture(t, {samples: [{error: "synthetic monitor failure"}]});
  const result = await f.run();
  assert.equal(result.interrupted, "driver_monitor_error:Error: synthetic monitor failure");
  assert.deepEqual(f.signals, ["SIGTERM"]);
  assert.equal(result.signal, "SIGTERM");
});

for (const [name, samples, expected] of [
  ["simulation limit", [{tick: 60000}], "simulation_limit_reached"],
  ["monitor error", [{error: "synthetic monitor failure"}],
    "driver_monitor_error:Error: synthetic monitor failure"],
]) {
  test(`${name} escalates cleanup to SIGKILL if SIGTERM is ignored`, async t => {
    const f = fixture(t, {samples, ignoreTerm: true});
    const result = await f.run();
    assert.equal(result.interrupted, expected);
    assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(result.signal, "SIGKILL");
    assert.deepEqual(f.waits, [1000, 3000]);
  });
}

test("negative and nonfinite wall deadlines are rejected", t => {
  const f = fixture(t);
  for (const value of ["-1", "NaN", "Infinity", "-Infinity"]) {
    assert.throws(() => f.parse(["--wall-timeout-seconds", value]), /invalid wallTimeoutSeconds/);
  }
});

test("round and simulation arguments cannot exceed 200 and 1200", t => {
  const f = fixture(t);
  assert.throws(() => f.parse(["--max-rounds", "201"]), /round cap/);
  assert.throws(() => f.parse(["--max-simulation-seconds", "1200.01"]), /simulation cap/);
  for (const option of ["--max-rounds", "--max-simulation-seconds"]) {
    for (const value of ["0", "-1", "NaN", "Infinity"]) {
      assert.throws(() => f.parse([option, value]), /invalid/);
    }
  }
});

test("lower positive caps reach the child unchanged and constrain simulation monitoring", async t => {
  const f = fixture(t, {samples: [{tick: 624}, {tick: 625}]});
  const result = await f.run(["--max-rounds", "17", "--max-simulation-seconds", "12.5",
    "--wall-timeout-seconds", "10"]);
  assert.equal(result.interrupted, "simulation_limit_reached");
  assert.equal(f.monitors.length, 2);
  assert.equal(f.configurations[0].max_rounds, 17);
  assert.equal(f.configurations[0].max_simulation_seconds, 12.5);
  assert.equal(result.capabilityPassed.max_rounds, 17);
  assert.equal(result.capabilityPassed.max_simulation_seconds, 12.5);
  assert.deepEqual(f.signals, ["SIGTERM"]);
});
