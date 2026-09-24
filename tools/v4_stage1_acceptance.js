#!/usr/bin/env node
"use strict";

// Stage 1 only. The evaluator selects a published fixture and owns CDP; the
// identical brainScript below receives ONLY a limited HTTP client. It cannot
// read the page, scene, native record, map identity, or evaluation truth.
// No legacy inloop driver is imported. --smoke is explicitly not six-run proof.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawn, spawnSync} = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TASK = "R2-GYI-MVP-02";
const DEFAULT_MAPS = ["map-03", "map-05", "map-10"];
const PUBLIC_METHODS = ["observe", "camera_parameters", "odometry", "local_road", "holding",
  "grab", "release", "forward", "backward", "turn", "follow_road", "take_exit"];
const SENSOR_METHODS = ["observe", "camera_parameters", "odometry", "local_road", "holding"];
const PAUSE_MS = 500;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const writeJson = (file, value) => fs.writeFileSync(file, json(value));

function parseArgs(argv) {
  const options = {maps: [...DEFAULT_MAPS], runs: 2, smoke: false,
    platformRoot: process.env.GUANGYANG_PLATFORM_ROOT || path.join(ROOT, "workspaces/guangyang-platform/projects/car-python"),
    timeoutMs: 90000};
  let explicitMaps = false, explicitRuns = false;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--smoke") { options.smoke = true; continue; }
    if (!["--out", "--maps", "--runs", "--platform-root", "--timeout-ms"].includes(key)
      || argv[index + 1] === undefined) throw new Error(`invalid argument: ${key}`);
    const value = argv[++index];
    if (key === "--maps") { options.maps = value.split(","); explicitMaps = true; }
    else if (key === "--runs") { options.runs = Number(value); explicitRuns = true; }
    else if (key === "--platform-root") options.platformRoot = value;
    else if (key === "--timeout-ms") options.timeoutMs = Number(value);
    else options.out = value;
  }
  if (options.smoke) {
    if (!explicitMaps) options.maps = ["map-03"];
    if (!explicitRuns) options.runs = 1;
  }
  assert.ok(options.out, "--out directory is required");
  assert.ok(options.maps.length && new Set(options.maps).size === options.maps.length
    && options.maps.every(id => /^map-(0[1-9]|10)$/.test(id)), "--maps must contain distinct map-01..map-10");
  assert.ok(Number.isSafeInteger(options.runs) && options.runs >= 1 && options.runs <= 10, "invalid --runs");
  assert.ok(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0, "invalid --timeout-ms");
  options.out = path.resolve(options.out);
  options.platformRoot = path.resolve(options.platformRoot);
  return options;
}

// No ignore list, tolerance, key removal, or identity special case is permitted.
function firstDifference(left, right, pointer = "") {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null
    || typeof left !== "object" || Array.isArray(left) !== Array.isArray(right)) {
    return {path: pointer || "/", left, right, reason: "value_or_type"};
  }
  const escape = key => String(key).replace(/~/g, "~0").replace(/\//g, "~1");
  const keys = Array.isArray(left)
    ? Array.from({length: Math.max(left.length, right.length)}, (_, index) => String(index))
    : [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    const here = `${pointer}/${escape(key)}`;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
      return {path: here, reason: "missing_field", leftPresent: Object.hasOwn(left, key),
        rightPresent: Object.hasOwn(right, key), ...(Object.hasOwn(left, key) ? {left: left[key]} : {right: right[key]})};
    }
    const difference = firstDifference(left[key], right[key], here);
    if (difference) return difference;
  }
  return null;
}

function oldNonWhitelistMethods(workerSource) {
  const robot = workerSource.split("class Robot:")[1]?.split("robot = Robot()")[0];
  assert.ok(robot, "cannot locate native worker Robot class");
  const methods = [...robot.matchAll(/^    async def ([a-z][a-z0-9_]*)\(/gm)].map(match => match[1]);
  assert.ok(methods.length >= 20, "unexpected old public Robot API inventory");
  return [...new Set(methods)].filter(method => !PUBLIC_METHODS.includes(method)).sort();
}

class HttpRobotClient {
  constructor({origin, bridgeId, clientToken, timeoutMs, contract}) {
    this.origin = origin; this.bridgeId = bridgeId; this.clientToken = clientToken;
    this.timeoutMs = timeoutMs; this.contract = contract; this.sequence = 0; this.transcript = [];
  }
  async http(route, method = "GET", body) {
    const response = await fetch(this.origin + route, {method, redirect: "error", credentials: "omit",
      headers: {"X-Robot-Bridge-Client": this.clientToken,
        ...(body === undefined ? {} : {"Content-Type": "application/json"})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(this.timeoutMs)});
    return {status: response.status, body: await response.json()};
  }
  async call(method, params = {}, {expectDenied = false, allowedError = null} = {}) {
    const request = {requestId: `command-${String(++this.sequence).padStart(4, "0")}`, method, params};
    const route = `/api/v1/robot-bridge/${this.bridgeId}/commands`;
    const submitted = await this.http(route, "POST", request);
    const entry = {request, submission: submitted, terminal: null};
    this.transcript.push(entry);
    if (expectDenied) {
      assert.equal(submitted.status, 400, `${method} must be rejected`);
      assert.equal(submitted.body.error?.code, "METHOD_NOT_ALLOWED", `${method} rejection code`);
      entry.terminal = submitted.body;
      return submitted.body;
    }
    assert.ok([200, 202].includes(submitted.status), `${method}: HTTP ${submitted.status} ${JSON.stringify(submitted.body)}`);
    let result = submitted.body;
    const deadline = Date.now() + this.timeoutMs;
    while (["queued", "dispatched"].includes(result.status)) {
      if (Date.now() > deadline) throw new Error(`${method} completion timeout`);
      await delay(20);
      const polled = await this.http(`${route}/${request.requestId}`);
      assert.equal(polled.status, 200, `${method} status query failed`);
      result = polled.body;
    }
    entry.terminal = result;
    if (allowedError && result.status === "failed" && result.error?.code === allowedError) return result;
    assert.equal(result.status, "completed", `${method}: ${JSON.stringify(result)}`);
    // The approved response schema is checked without silently stripping extras.
    assert.deepEqual(result.result, this.contract.sanitizeResponse(method, result.result), `${method} leaked a noncontract field`);
    return result.result;
  }
  async deniedScope(route) {
    const response = await this.http(route);
    assert.equal(response.status, 403, `${route} must reject the limited capability`);
    assert.equal(response.body.error?.code, "CLIENT_CAPABILITY_SCOPE");
    return {route: route.replace(this.bridgeId, "<controller-managed-bridge>"), ...response};
  }
}

// This function is the entire brain. It is map independent and receives no CDP,
// scene, record, layout or evaluator objects. Its motion constants are a fixed
// interface exercise, not a task policy or a tuned capture/navigation algorithm.
async function brainScript(client, rejectedMethods) {
  const beforeSensors = await client.call("odometry");
  await client.call("camera_parameters");
  await client.call("local_road");
  await client.call("holding");
  await client.call("observe", {category: null, confidence: 0});
  await client.call("observe", {category: null, confidence: 0});
  const beforePause = await client.call("odometry");
  assert.deepEqual(beforePause, beforeSensors, "sensor-only calls changed odometry");
  await delay(PAUSE_MS);
  const afterPause = await client.call("odometry");
  assert.deepEqual(afterPause, beforePause, "wall-clock pause advanced the simulation");
  for (const method of rejectedMethods) await client.call(method, {}, {expectDenied: true});
  const afterDenied = await client.call("odometry");
  assert.deepEqual(afterDenied, afterPause, "rejected legacy methods advanced the simulation");
  await client.call("follow_road", {distanceCm: 30, speed: 30});
  await client.call("observe", {category: null, confidence: 0});
  await client.call("odometry");
  await client.call("turn", {angleDeg: 10});
  await client.call("turn", {angleDeg: -10});
  await client.call("backward", {distanceCm: 5, speed: 30});
  await client.call("forward", {distanceCm: 5, speed: 30});
  await client.call("holding");
  const end = await client.call("odometry");
  assert.ok(end.tick > afterDenied.tick, "motion controls did not advance any simulation tick");
  return {sensorTicks: {before: beforeSensors.tick, after: beforePause.tick},
    pause: {wallClockPauseMs: PAUSE_MS, beforeTick: beforePause.tick, afterTick: afterPause.tick},
    rejectedMethods, endTick: end.tick};
}

class Cdp {
  constructor() { this.nextId = 0; this.pending = new Map(); this.pageErrors = []; }
  async connect(url) {
    this.socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 20000);
      this.socket.addEventListener("open", () => {clearTimeout(timer); resolve();}, {once: true});
      this.socket.addEventListener("error", () => {clearTimeout(timer); reject(new Error("CDP connection failed"));}, {once: true});
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") this.pageErrors.push(message.params.exceptionDetails);
      if (!this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 120000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(new Error(`CDP ${method} timeout`));}, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  close() {
    for (const pending of this.pending.values()) {clearTimeout(pending.timer); pending.reject(new Error("CDP closed"));}
    this.pending.clear(); this.socket?.close();
  }
}

function chromePath() {
  for (const candidate of [process.env.CHENLONG_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "google-chrome", "chromium"].filter(Boolean)) {
    if (path.isAbsolute(candidate) ? fs.existsSync(candidate) : spawnSync(candidate, ["--version"], {stdio: "ignore"}).status === 0) return candidate;
  }
  throw new Error("Chrome/Edge not found; set CHENLONG_BROWSER_PATH");
}

async function waitFor(check, label, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(100);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

function auditRecord(record, transcript, rejectedMethods) {
  const failures = [];
  const check = (condition, message) => {if (!condition) failures.push(message);};
  check(record?.schemaVersion === "guangyang.robot-record/v1" && record.complete === true, "complete robot record missing");
  const native = record?.native || {};
  for (const key of ["runId", "serverSessionId", "challengeDigest", "teamId", "clientStartedAt", "clientEndedAt"]) {
    check(!Object.hasOwn(native, key), `native management field ${key} remains in deterministic record`);
  }
  const calls = record?.calls || [];
  const acceptedRequests = transcript.filter(entry => entry.submission.status < 400);
  check(calls.length === acceptedRequests.length, "record calls does not cover every accepted HTTP request");
  acceptedRequests.forEach((entry, index) => {
    const call = calls[index];
    check(call?.method === entry.request.method && !firstDifference(call?.args, entry.request.params), `HTTP→call mismatch ${index}`);
    check(!firstDifference(call?.outcome?.result, entry.terminal?.result), `HTTP→result mismatch ${index}`);
  });
  for (const call of calls) {
    check(Number.isSafeInteger(call.started?.tick) && Number.isSafeInteger(call.finished?.tick), `call ${call.seq} tick missing`);
    if (SENSOR_METHODS.includes(call.method)) check(call.started.tick === call.finished.tick, `${call.method} advanced tick`);
  }
  const bridge = record?.bridgeCalls || [];
  check(Array.isArray(bridge), "server bridge trace missing");
  for (const method of rejectedMethods) check(bridge.some(row => row.type === "rejected"
    && row.method === method && row.code === "METHOD_NOT_ALLOWED"), `server trace missing denial ${method}`);
  const ledger = record?.ledger || [];
  ledger.forEach((row, index) => check(row.seq === index + 1 && Number.isSafeInteger(row.tick), `ledger seq/tick ${index}`));
  const nativeCount = ["inputs", "events", "samples", "visionFrames"].reduce((sum, key) => sum + (native[key]?.length || 0), 0);
  check(ledger.filter(row => row.kind === "native").length === nativeCount, "native ledger coverage mismatch");
  return {allPass: failures.length === 0, failures, calls: calls.length, nativeItems: nativeCount,
    frames: native.visionFrames?.length || 0, serverTraceEvents: bridge.length};
}

function saveEvidence(directory, exported) {
  fs.mkdirSync(path.join(directory, "frames"), {recursive: true});
  writeJson(path.join(directory, "record.json"), exported.record);
  writeJson(path.join(directory, "envelope.json"), exported.envelope);
  writeJson(path.join(directory, "samples.json"), exported.record.native.samples);
  const frames = (exported.record.native.visionFrames || []).map(frame => {
    const bytes = Buffer.from(frame.pngBase64, "base64");
    assert.equal(bytes.length, frame.byteLength, "PNG byte count mismatch");
    assert.equal(sha(bytes), frame.sha256, "PNG SHA mismatch");
    const image = `frames/frame-${String(frame.seq).padStart(6, "0")}.png`;
    fs.writeFileSync(path.join(directory, image), bytes);
    const {pngBase64, ...fields} = frame;
    return {...fields, image};
  });
  writeJson(path.join(directory, "frames.json"), {schema: "wm-v4-native-png-export/v1", frames,
    totalBytes: frames.reduce((sum, frame) => sum + frame.byteLength, 0)});
  return {recordSha256: sha(fs.readFileSync(path.join(directory, "record.json"))),
    frames: frames.length, pngBytes: frames.reduce((sum, frame) => sum + frame.byteLength, 0)};
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (fs.existsSync(path.join(options.out, "acceptance.json"))) throw new Error("refusing to overwrite completed acceptance output");
  fs.mkdirSync(options.out, {recursive: true});
  const platform = options.platformRoot;
  const {createServer} = require(path.join(platform, "server.js"));
  const contract = require(path.join(platform, "robot-bridge-contract.js"));
  assert.deepEqual(contract.METHODS, PUBLIC_METHODS, "whitelist changed; review fixed driver protocol before running");
  const rejectedMethods = oldNonWhitelistMethods(fs.readFileSync(path.join(platform, "python-worker.js"), "utf8"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wm-v4-stage1-"));
  const profile = path.join(temp, "browser"); fs.mkdirSync(profile);
  const server = createServer({dataDir: path.join(temp, "data"), robotBridgeEnabled: true, robotBridge: {pollTimeoutMs: 1000}});
  const originalPool = new Map(server.mapConfigPools.get(TASK));
  const sources = ["competition-core.js", "robot-record.js", "robot-backend-runtime.js", "robot-bridge-contract.js",
    "backend/robot-bridge.js", "server.js", "app.js", "vision.js", "vision-pixel-core.js", "python-worker.js"];
  const manifest = {driver: {file: path.relative(ROOT, __filename), sha256: sha(fs.readFileSync(__filename))},
    platformRoot: platform, platform: Object.fromEntries(sources.map(file => [file, sha(fs.readFileSync(path.join(platform, file)))])),
    brainScriptSha256: sha(brainScript.toString()), rejectedMethods, pauseMs: PAUSE_MS};
  writeJson(path.join(options.out, "manifest.json"), manifest);
  const summary = {schema: "wm-v4-stage1-acceptance/v1", smoke: options.smoke, maps: options.maps, runsPerMap: options.runs,
    status: "running", manifest, trials: [], comparisons: [], allPass: false,
    fullSixRunAcceptance: !options.smoke && options.runs === 2 && !firstDifference(options.maps, DEFAULT_MAPS)};
  let browser, cdp, evaluate, sessionId;
  try {
    await new Promise((resolve, reject) => {server.once("error", reject); server.listen(0, "127.0.0.1", resolve);});
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = spawn(chromePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      "--window-size=1280,900", "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync",
      "--metrics-recording-only", "--no-proxy-server", "--disable-features=MediaRouter",
      "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "about:blank"], {stdio: ["ignore", "ignore", "pipe"]});
    browser.stderr.on("data", () => {});
    const debug = await waitFor(() => {
      if (browser.exitCode !== null) throw new Error(`Chrome exited ${browser.exitCode}`);
      const file = path.join(profile, "DevToolsActivePort");
      if (!fs.existsSync(file)) return null;
      const [port, suffix] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
      return port && suffix ? `ws://127.0.0.1:${port}${suffix}` : null;
    }, "Chrome DevTools", 20000);
    cdp = new Cdp(); await cdp.connect(debug);
    const target = await cdp.send("Target.createTarget", {url: "about:blank"});
    sessionId = (await cdp.send("Target.attachToTarget", {targetId: target.targetId, flatten: true})).sessionId;
    await cdp.send("Runtime.enable", {}, sessionId); await cdp.send("Page.enable", {}, sessionId);
    evaluate = async expression => {
      const response = await cdp.send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true, userGesture: true}, sessionId, options.timeoutMs);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    const navigate = async url => {
      await cdp.send("Page.navigate", {url}, sessionId);
      await waitFor(() => evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`), "page load");
    };
    await navigate(`${origin}/login.html`);
    const username = `v4-${crypto.randomBytes(8).toString("hex")}`;
    const password = `V4-${crypto.randomBytes(16).toString("hex")}`;
    const registration = await evaluate(`(async () => {
      const response = await fetch('/api/v1/auth/register', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(${JSON.stringify({username, password, teamName: "V4 stage1 evaluator", group: "primary"})})});
      return {status:response.status}; })()`);
    assert.equal(registration.status, 201, "evaluator account registration failed");
    for (const map of options.maps) {
      const store = originalPool.get(map); assert.ok(store, `missing native pool ${map}`);
      // Evaluation-only fixture selection. Every assignment resolves to this
      // unmodified native store; no object coordinates enter the brain client.
      for (const key of server.mapConfigPools.get(TASK).keys()) server.mapConfigPools.get(TASK).set(key, store);
      const publication = await store.publicConfig();
      await navigate(`${origin}/`);
      await waitFor(() => evaluate(`typeof RobotBackend === 'object' && typeof activeMission === 'object'
        && document.querySelector('#runButton')?.disabled === false
        && (!document.querySelector('#loadingOverlay') || document.querySelector('#loadingOverlay').classList.contains('is-hidden'))`), "robot workspace");
      await evaluate(`(async () => {
        await refreshPublishedGuangyangMap({config:guangyangConfigForTaskId(${JSON.stringify(TASK)}),apply:false});
        loadMission('guangyang2'); return activeMission.competition.config.taskId; })()`);
      const loaded = await evaluate(`publishedGuangyangMapConfigs.get(${JSON.stringify(TASK)})`);
      assert.deepEqual(loaded.layout, publication.layout, "browser did not load selected native layout");
      for (let run = 1; run <= options.runs; run++) {
        const directory = path.join(options.out, `${map}-run-${run}`); fs.mkdirSync(directory, {recursive: true});
        writeJson(path.join(directory, "evaluation-map.json"), {map, taskId: TASK, publication,
          note: "evaluator-only native map selection; never supplied to HTTP brain"});
        const trial = {map, run, directory: path.basename(directory), allPass: false};
        let started = false, client = null, exported = null;
        const errorCursor = cdp.pageErrors.length;
        try {
          const capability = await evaluate("RobotBackend.start({provenance:{purpose:'v4-stage1-acceptance'}})");
          started = true;
          client = new HttpRobotClient({...capability, origin, timeoutMs: options.timeoutMs, contract});
          trial.backendVersion = capability.version; trial.protocolVersion = capability.protocolVersion;
          trial.script = await brainScript(client, rejectedMethods);
          trial.scopeChecks = [];
          for (const route of [`/api/v1/map-config/${TASK}`, "/api/v1/records",
            `/api/v1/robot-bridge/controllers/${capability.bridgeId}/trace`]) trial.scopeChecks.push(await client.deniedScope(route));
        } catch (error) { trial.error = String(error.stack || error); }
        finally {
          if (started) {
            try {exported = await evaluate("RobotBackend.stop('finished')");}
            catch (error) {trial.stopError = String(error.stack || error);}
          }
        }
        trial.pageErrors = cdp.pageErrors.slice(errorCursor);
        if (client) writeJson(path.join(directory, "http-transcript.json"), client.transcript);
        if (exported) {
          try {
            trial.evidence = saveEvidence(directory, exported);
            trial.recordAudit = auditRecord(exported.record, client?.transcript || [], rejectedMethods);
            trial.controllerErrors = exported.envelope?.controllerErrors || [];
          } catch (error) {trial.evidenceError = String(error.stack || error);}
        }
        trial.allPass = !trial.error && !trial.stopError && !trial.evidenceError && trial.recordAudit?.allPass === true
          && trial.controllerErrors?.length === 0 && trial.pageErrors.length === 0;
        writeJson(path.join(directory, "evaluation.json"), trial);
        summary.trials.push(trial);
        writeJson(path.join(options.out, "progress.json"), summary);
        console.error(`V4 ${map} run ${run}: ${trial.allPass ? "PASS" : "FAIL"}`);
        if (trial.stopError) throw new Error("backend stop failed; record boundary is uncertain, aborting remaining trials");
      }
      const trials = summary.trials.filter(trial => trial.map === map);
      for (let index = 1; index < trials.length; index++) {
        const leftPath = path.join(options.out, trials[0].directory, "record.json");
        const rightPath = path.join(options.out, trials[index].directory, "record.json");
        const available = fs.existsSync(leftPath) && fs.existsSync(rightPath);
        const difference = available ? firstDifference(JSON.parse(fs.readFileSync(leftPath)), JSON.parse(fs.readFileSync(rightPath))) : {reason: "missing_record"};
        summary.comparisons.push({map, left: trials[0].directory, right: trials[index].directory,
          equalEveryField: difference === null, firstDifference: difference});
      }
    }
    summary.status = "complete";
  } catch (error) {summary.status = "failed"; summary.error = String(error.stack || error);}
  finally {
    summary.frozenSourcesUnchanged = Object.fromEntries(sources.map(file => [file,
      sha(fs.readFileSync(path.join(platform, file))) === manifest.platform[file]]));
    summary.allPass = summary.status === "complete" && summary.trials.length === options.maps.length * options.runs
      && summary.trials.every(trial => trial.allPass) && summary.comparisons.every(row => row.equalEveryField)
      && Object.values(summary.frozenSourcesUnchanged).every(Boolean);
    writeJson(path.join(options.out, "acceptance.json"), summary);
    cdp?.close();
    if (browser && browser.exitCode === null) {
      browser.kill("SIGTERM");
      await Promise.race([new Promise(resolve => browser.once("exit", resolve)), delay(3000)]);
      if (browser.exitCode === null) browser.kill("SIGKILL");
    }
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, {recursive: true, force: true});
  }
  process.exitCode = summary.allPass ? 0 : 1;
  console.log(JSON.stringify({out: options.out, allPass: summary.allPass, fullSixRunAcceptance: summary.fullSixRunAcceptance,
    trials: summary.trials.length, comparisons: summary.comparisons.length}));
  return summary;
}

module.exports = {parseArgs, firstDifference, oldNonWhitelistMethods, HttpRobotClient, brainScript, auditRecord, saveEvidence, main};
if (require.main === module) main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
