#!/usr/bin/env node
"use strict";

// Trusted evaluation harness. Only the child Python process is the robot brain.
// Map selection, page control, detector audits and scene truth remain here.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {createGzip} = require("node:zlib");
const {Transform} = require("node:stream");
const {pipeline} = require("node:stream/promises");
const {spawn, spawnSync} = require("node:child_process");
const {verifyPreflightGate} = require("./fresh_map05_platform_gate.js");
const VERSION = "wm-autonomous-brain-driver/v9";
const ROOT = path.resolve(__dirname, "..");
const LLM_REQUIRED_KEYS = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"];
const LLM_CONFIG_KEYS = new Set([...LLM_REQUIRED_KEYS, "LLM_TEMPERATURE", "LLM_THINKING"]);
const TASK = "R2-GYI-MVP-02";
const FORMAL_MODEL = "deepseek-flash";
const PUBLIC_METHODS = ["observe", "camera_parameters", "odometry", "local_road", "holding", "grab", "release", "forward", "backward", "turn", "follow_road", "take_exit"];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const relative = file => path.relative(ROOT, file);
const json = value => JSON.stringify(value, null, 2) + "\n";
const writeJson = (file, value) => fs.writeFileSync(file, json(value));
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

function parseLocalLLMConfig(source) {
  const values = Object.create(null);
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) throw new Error(`Invalid local LLM config assignment at line ${index + 1}`);
    const [, key, rawValue] = assignment;
    if (!LLM_CONFIG_KEYS.has(key)) continue;
    let value;
    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const quoted = /^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(rawValue);
      if (!quoted) throw new Error(`Invalid ${key} quoting at line ${index + 1}`);
      value = quoted[1] ?? quoted[2];
    } else {
      value = rawValue.replace(/\s+#.*$/, "").trimEnd();
    }
    values[key] = value;
  }
  return values;
}

function loadLocalLLMConfig(file = path.join(ROOT, ".env.local"), env = process.env) {
  let source;
  try { source = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("Unable to read local LLM config file");
  }
  const values = parseLocalLLMConfig(source);
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(env, key)) env[key] = value;
  }
}

function parseArgs(argv) {
  const options = {maps: ["map-05"], runs: 1,
    platformRoot: process.env.GUANGYANG_PLATFORM_ROOT || path.join(ROOT, "workspaces/guangyang-platform/projects/car-python"),
    python: process.env.BRAIN_PYTHON || "python3", timeoutMs: 120000, wallTimeoutSeconds: 0,
    maxRounds: 200, maxSimulationSeconds: 1200, task: "把两个红球送到绿色存放区"};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    assert.ok(value !== undefined, `${key} requires a value`);
    if (key === "--out") options.out = path.resolve(value);
    else if (key === "--maps") options.maps = value.split(",");
    else if (key === "--runs") options.runs = Number(value);
    else if (key === "--platform-root") options.platformRoot = path.resolve(value);
    else if (key === "--python") options.python = value;
    else if (key === "--task") options.task = value;
    else if (key === "--replay") options.replay = path.resolve(value);
    else if (key === "--map05-success" || key === "--stage2-success") options.stage2Success = path.resolve(value);
    else if (key === "--timeout-ms") options.timeoutMs = Number(value);
    else if (key === "--wall-timeout-seconds") options.wallTimeoutSeconds = Number(value);
    else if (key === "--max-rounds") options.maxRounds = Number(value);
    else if (key === "--max-simulation-seconds") options.maxSimulationSeconds = Number(value);
    else throw new Error(`unsupported argument ${key}`);
  }
  assert.ok(options.out, "--out is required");
  assert.ok(options.maps.length && new Set(options.maps).size === options.maps.length
    && options.maps.every(id => /^map-(0[1-9]|10)$/.test(id)), "--maps accepts distinct map-01..map-10");
  assert.ok(Number.isSafeInteger(options.runs) && options.runs >= 1 && options.runs <= 10, "invalid --runs");
  for (const key of ["timeoutMs", "maxRounds", "maxSimulationSeconds"]) assert.ok(Number.isFinite(options[key]) && options[key] > 0, `invalid ${key}`);
  assert.ok(Number.isFinite(options.wallTimeoutSeconds) && options.wallTimeoutSeconds >= 0, 'invalid wallTimeoutSeconds');
  assert.ok(Number.isInteger(options.maxRounds) && options.maxRounds <= 200, "round cap must be <= 200");
  assert.ok(options.maxSimulationSeconds <= 1200, "simulation cap must be <= 1200 seconds");
  assert.ok(options.task.length > 0 && options.task.length <= 10000, "invalid task");
  return options;
}

// Read-only camera-render hook: captures actual pose and truth at the exact
// sensor rendering boundary, before asynchronous vision work. It does not alter
// the image, simulator, detector output or bridge response. No frame hash needed.
function installEvaluationCapture() {
  const originalRender = renderer.render;
  const originalEvidence = addCompetitionVisionEvidence;
  let rendered = null;
  globalThis.__brainEvaluationCaptures = [];
  renderer.render = function(sceneArg, cameraArg) {
    if (cameraArg === virtualCamera && simulationVisionRunActive) {
      const context = simulationVisionContext();
      const objects = packageMeshes.map(mesh => ({id: mesh.userData.packageId,
        category: mesh.userData.objectCategory === "target" ? "red-ball" : mesh.userData.objectCategory === "distractor" ? "blue-ball" : "obstacle",
        centerWorld: mesh.getWorldPosition(new THREE.Vector3()).toArray(),
        active: mesh.visible && mesh.userData.packageId !== heldPackageId}));
      for (const mesh of obstacleMeshes) {
        if (!mesh.userData.interactionObjectId) continue;
        objects.push({id: mesh.userData.interactionObjectId, category: "obstacle",
          centerWorld: mesh.localToWorld(new THREE.Vector3(0, 0.43, 0)).toArray(), active: mesh.visible});
      }
      rendered = {tick: context.tick, stateRevision: context.stateRevision, stepMs: context.stepMs,
        cameraPose: {matrixWorld: [...virtualCamera.matrixWorld.elements], worldUnitsToCm: 12.5,
          ...Object.fromEntries(["fx", "fy", "cx", "cy"].map(key => [key, RobotBridgeContract.CAMERA_PARAMETERS[key]]))},
        robotWorldPose: {...robotPose}, odometryOrigin: {...realtimeRun.navigationOrigin},
        worldUnitsToMeters: 0.125, holdingTruthId: heldPackageId, truthObjects: objects};
    }
    return originalRender.call(this, sceneArg, cameraArg);
  };
  addCompetitionVisionEvidence = function(canvas, frameId, context) {
    if (context && rendered) {
      if (rendered.tick !== context.tick || rendered.stateRevision !== context.stateRevision) throw new Error("Evaluation capture binding mismatch");
      globalThis.__brainEvaluationCaptures.push({frameId, ...JSON.parse(JSON.stringify(rendered))});
    }
    return originalEvidence(canvas, frameId, context);
  };
  return true;
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
      const timer = setTimeout(() => {this.pending.delete(id); reject(Object.assign(new Error(`CDP ${method} timeout`), {code: 'CDP_TIMEOUT'}));}, timeoutMs);
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

function validateFormalLLMConfig(env = process.env) {
  for (const name of LLM_REQUIRED_KEYS) assert.ok(env[name], `${name} must be configured before a formal run`);
  let endpointValid = false;
  const endpoint = env.LLM_BASE_URL;
  if (typeof endpoint === 'string' && /^https?:\/\/[^/?#]+/i.test(endpoint)
      && !/^https?:\/\/[^/?#]*@/i.test(endpoint) && !/[\\\s\u0000-\u001f\u007f]/.test(endpoint)) {
    try {
      const url = new URL(endpoint);
      endpointValid = ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname)
        && !url.username && !url.password && !url.search && !url.hash
        && (!url.port || Number(url.port) >= 1);
    } catch { /* Parser errors can contain configuration; discard them. */ }
  }
  if (!endpointValid) throw new Error('invalid_configuration:LLM_BASE_URL');
  if (typeof env.LLM_API_KEY !== 'string' || /[\u0000-\u001f\u007f]/.test(env.LLM_API_KEY)) {
    throw new Error('invalid_configuration:LLM_API_KEY');
  }
  let temperature;
  try { temperature = JSON.parse(env.LLM_TEMPERATURE ?? '0'); }
  catch { throw new Error('Formal run requires temperature=0'); }
  if (env.LLM_MODEL !== FORMAL_MODEL) throw new Error('Formal run requires deepseek-flash');
  if (temperature !== 0) throw new Error('Formal run requires temperature=0');
  if (env.LLM_THINKING !== 'disabled') throw new Error('Formal run requires thinking=disabled');
  return {model: env.LLM_MODEL, temperature, thinking: env.LLM_THINKING,
    response_format: {type: 'json_object'}, stream: true, formal_run: true};
}

function sourceTree(directory, extensions) {
  const files = [];
  const excluded = new Set(['.git', '__pycache__', 'node_modules', 'data', 'reports', 'artifacts', 'tests', 'logs']);
  function visit(current) {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      if (excluded.has(entry.name) || entry.name.startsWith('.')) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && extensions.has(path.extname(file))) files.push(file);
    }
  }
  visit(directory);
  return Object.fromEntries(files.sort().map(file => [path.relative(directory, file), sha(fs.readFileSync(file))]));
}

function worldModelProvenance(python = 'python3', env = process.env) {
  const root = path.resolve(env.WORLD_MODEL_ROOT || path.join(ROOT, 'vendor/wm_kit_opt2'));
  const checked = spawnSync(python, ['-m', 'autonomous_brain.provenance', '--root', root],
    {cwd: ROOT, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  assert.equal(checked.status, 0, 'Cannot attest the actual WorldModel dependency');
  return {...JSON.parse(checked.stdout), selection: env.WORLD_MODEL_ROOT ? 'WORLD_MODEL_ROOT' : 'vendored_default'};
}

function gitRevision(directory) {
  const result = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : null;
}

function evaluatorDependencies(root = ROOT) {
  // These modules perform independent witness checking and raw model replay.
  // Their bytes belong to the frozen evaluator, even though they are helpers.
  return Object.fromEntries([
    'tools/brain_evidence_audit.py',
    'tools/replay_brain_llm.py',
    'tools/brain_topology_audit.py',
  ].map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
}

function sourceManifest(platformRoot, options = {}) {
  const preflight = readJson(path.join(ROOT, 'artifacts/autonomous-brain/fresh-map05-gate-20260925/preflight-gate.json'));
  const files = Object.keys(preflight.run.platform);
  const brainFiles = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.py')) brainFiles.push(file);
    }
  }
  visit(path.join(ROOT, 'autonomous_brain'));
  return {version: VERSION, driver: {file: relative(__filename), sha256: sha(fs.readFileSync(__filename))},
    platform: Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(platformRoot, file)))])),
    brain: Object.fromEntries(brainFiles.sort().map(file => [relative(file), sha(fs.readFileSync(file))])),
    brainRevision: gitRevision(ROOT), platformRevision: gitRevision(platformRoot),
    runtime: {node: process.version, nodeExecutable: process.execPath},
    platformRoot: fs.realpathSync(platformRoot),
    platformRuntimeSources: sourceTree(platformRoot, new Set(['.js', '.mjs', '.html', '.json', '.wasm', '.css', '.onnx'])),
    worldModel: worldModelProvenance(options.python, process.env),
    modelConfiguration: options.replay ? {mode: 'replay', source: options.replay,
      sha256: sha(fs.readFileSync(options.replay)), formal_run: false} : validateFormalLLMConfig(),
    runConfiguration: {task: options.task ?? null, maxRounds: options.maxRounds ?? null,
      maxSimulationSeconds: options.maxSimulationSeconds ?? null, wallTimeoutSeconds: options.wallTimeoutSeconds ?? null},
    dependencyLock: {file: 'vendor/worldmodel.lock.json', sha256: sha(fs.readFileSync(path.join(ROOT, 'vendor/worldmodel.lock.json'))),
      scope: 'historical upstream base only; actual loaded files are recorded in worldModel'},
    evaluator: {file: 'tools/evaluate_autonomous_brain.py', sha256: sha(fs.readFileSync(path.join(ROOT, 'tools/evaluate_autonomous_brain.py')))},
    evaluatorDependencies: evaluatorDependencies(),
    evaluatorCaptureSha256: sha(installEvaluationCapture.toString()),
    platformGate: 'artifacts/autonomous-brain/fresh-map05-gate-20260925/preflight-gate.json',
    platformGateReviewer: {file: 'tools/fresh_map05_platform_gate.js', sha256: sha(fs.readFileSync(path.join(__dirname, 'fresh_map05_platform_gate.js')))},
    publicMethods: PUBLIC_METHODS};
}

// Installed only in the evaluator's page, after the child brain has exited.
// The platform still clones internally in stop(); this removes the additional
// unbounded CDP returnByValue and host JSON.stringify of that complete export.
function installChunkedEvaluationExport() {
  const state = {phase: 'idle', value: null, error: null};
  const streams = new Map();
  const datasets = new Set(['record', 'samples', 'sensorAudit', 'captures', 'envelope']);
  function status() {
    return {phase: state.phase, error: state.error,
      recordFrameCount: state.value?.record?.native?.visionFrames?.length ?? null,
      captureCount: globalThis.__brainEvaluationCaptures?.length ?? null};
  }
  // JSON data only. Emit arrays/objects lazily, preserving property order and
  // the usual two-space JSON encoding without constructing the complete text.
  function* encode(value, depth = 0, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || typeof value === 'number' && Number.isFinite(value)) {
      yield JSON.stringify(value); return;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('non-JSON export value');
    ancestors.add(value);
    const array = Array.isArray(value), keys = array ? null : Object.keys(value);
    const length = array ? value.length : keys.length;
    yield array ? '[' : '{';
    for (let index = 0; index < length; index++) {
      yield (index ? ',\n' : '\n') + '  '.repeat(depth + 1);
      const key = array ? index : keys[index];
      if (!array) yield JSON.stringify(key) + ': ';
      yield* encode(value[key], depth + 1, ancestors);
    }
    if (length) yield '\n' + '  '.repeat(depth);
    yield array ? ']' : '}';
    ancestors.delete(value);
  }
  function root(name) {
    if (!datasets.has(name)) throw new Error('unknown export dataset');
    if (name === 'captures') {
      if (!Array.isArray(globalThis.__brainEvaluationCaptures)) throw new Error('captures unavailable');
      return globalThis.__brainEvaluationCaptures;
    }
    if (state.phase !== 'ready') throw new Error('backend export not ready: ' + state.phase);
    const value = name === 'samples' ? state.value.record?.native?.samples : state.value[name];
    if (value === undefined) throw new Error('export dataset unavailable: ' + name);
    return value;
  }
  function open(name) {
    if (!streams.has(name)) {
      const value = root(name);
      function* document() {yield* encode(value); yield '\n';}
      streams.set(name, {iterator: document(), pending: '', exhausted: false, failed: null,
        next: 0, characters: 0, last: null});
    }
    return {name, opened: true};
  }
  function read(name, sequence, limit) {
    const stream = streams.get(name);
    if (!stream || !Number.isSafeInteger(sequence) || !Number.isSafeInteger(limit)
        || limit < 2 || limit > 65536) throw new Error('invalid export chunk request');
    if (stream.failed) throw new Error(stream.failed);
    // One retained response makes an uncertain transport retry idempotent.
    if (stream.last?.sequence === sequence) return stream.last;
    if (sequence !== stream.next || stream.last?.done) throw new Error('export chunk sequence mismatch');
    let text = '';
    try {while (text.length < limit) {
      if (!stream.pending && !stream.exhausted) {
        const next = stream.iterator.next();
        stream.exhausted = next.done;
        if (!next.done) stream.pending = next.value;
      }
      if (!stream.pending) break;
      let take = Math.min(limit - text.length, stream.pending.length);
      const last = stream.pending.charCodeAt(take - 1), next = stream.pending.charCodeAt(take);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) take--;
      if (!take) break;
      text += stream.pending.slice(0, take);
      stream.pending = stream.pending.slice(take);
    }} catch (error) {stream.failed = 'export serialization failed: ' + String(error.message || error); throw error;}
    stream.characters += text.length;
    const done = stream.exhausted && !stream.pending;
    stream.last = {name, sequence, text, done, characters: stream.characters};
    stream.next++;
    return stream.last;
  }
  globalThis.__brainChunkedExport = Object.freeze({status, open, read,
    evaluateRecord(callback) {return callback(root('record'));},
    start() {
      if (state.phase === 'idle') {
        state.phase = 'stopping';
        Promise.resolve().then(() => RobotBackend.stop('finished')).then(value => {
          state.value = value; state.phase = 'ready';
        }, error => {state.error = String(error?.stack || error).slice(0, 8192); state.phase = 'failed';});
      }
      return status();
    }});
  return {installed: true, maxChunkCharacters: 65536};
}

async function stopForChunkedExport(evaluate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  await evaluate(`(${installChunkedEvaluationExport.toString()})()`, Math.max(1, deadline - Date.now()));
  let state = await evaluate('__brainChunkedExport.start()', Math.max(1, deadline - Date.now()));
  while (state.phase === 'stopping') {
    if (Date.now() >= deadline) throw new Error('backend stop deadline exceeded');
    await delay(Math.min(100, deadline - Date.now()));
    state = await evaluate('__brainChunkedExport.status()', Math.max(1, deadline - Date.now()));
  }
  if (state.phase !== 'ready') throw new Error(`backend stop failed: ${state.error || state.phase}`);
  return state;
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {hash.update(chunk); bytes += chunk.length;}
  return {sha256: hash.digest('hex'), bytes};
}

async function savePageDataset(evaluate, name, file, options = {}) {
  const chunkCharacters = options.chunkCharacters ?? 65536;
  const maxChunks = options.maxChunks ?? 100000;
  const deadline = options.deadline ?? Date.now() + 600000;
  const compressed = options.compressed !== false;
  assert.ok(Number.isSafeInteger(chunkCharacters) && chunkCharacters >= 2 && chunkCharacters <= 65536);
  assert.ok(Number.isSafeInteger(maxChunks) && maxChunks > 0);
  const partial = file + '.part', progressFile = file + '.export-progress.json';
  assert.ok(!fs.existsSync(file) && !fs.existsSync(partial) && !fs.existsSync(progressFile), 'refusing to overwrite export evidence');
  const request = expression => {
    if (Date.now() >= deadline) throw new Error('evidence export deadline exceeded');
    return evaluate(expression, Math.min(options.requestTimeoutMs ?? 120000, Math.max(1, deadline - Date.now())));
  };
  const opened = await request(`__brainChunkedExport.open(${JSON.stringify(name)})`);
  assert.equal(opened?.name, name); assert.equal(opened.opened, true);
  const source = compressed ? createGzip({level: 9}) : new Transform({transform(chunk, encoding, callback) {callback(null, chunk);}});
  const output = fs.createWriteStream(partial, {flags: 'wx'});
  const completed = pipeline(source, output);
  completed.catch(() => {});
  const expanded = crypto.createHash('sha256');
  let characters = 0, expandedBytes = 0, chunks = 0, done = false;
  let expandedDigest = null, published = false;
  const progress = (phase, extra = {}) => writeJson(progressFile, {
    dataset: name, phase, complete: phase === 'complete', file: path.basename(phase === 'complete' ? file : partial),
    chunks, characters, expandedBytes, ...extra});
  try {
    progress('streaming');
    for (let sequence = 0; sequence < maxChunks; sequence++) {
      const expression = `__brainChunkedExport.read(${JSON.stringify(name)},${sequence},${chunkCharacters})`;
      let chunk;
      try {chunk = await request(expression);}
      catch (error) {
        // No simulator call is repeated: only the page's cached same-sequence chunk.
        if (error.code !== 'CDP_TIMEOUT' || Date.now() >= deadline) throw error;
        chunk = await request(expression);
      }
      assert.equal(chunk?.name, name, 'export dataset mismatch');
      assert.equal(chunk.sequence, sequence, 'export chunk sequence mismatch');
      assert.equal(typeof chunk.text, 'string'); assert.equal(typeof chunk.done, 'boolean');
      assert.ok(chunk.text.length <= chunkCharacters && (chunk.text.length || chunk.done), 'invalid export chunk length');
      assert.equal(chunk.characters, characters + chunk.text.length, 'export character endcap mismatch');
      // The page never splits a Unicode surrogate pair between UTF-8 writes.
      const tail = chunk.text.charCodeAt(chunk.text.length - 1);
      assert.ok(!(tail >= 0xd800 && tail <= 0xdbff), 'split Unicode export chunk');
      const bytes = Buffer.from(chunk.text, 'utf8');
      await new Promise((resolve, reject) => source.write(bytes, error => error ? reject(error) : resolve()));
      expanded.update(bytes); expandedBytes += bytes.length; characters += chunk.text.length; chunks++;
      progress('streaming');
      if (chunk.done) {done = true; break;}
    }
    assert.ok(done, 'export chunk limit reached without endcap');
    source.end(); await completed;
    const packed = await hashFile(partial);
    expandedDigest = expanded.digest('hex');
    const evidence = {file: path.basename(file), compression: compressed ? 'gzip' : 'none', ...packed,
      expandedSha256: expandedDigest, expandedBytes};
    fs.renameSync(partial, file);
    published = true;
    progress('complete', evidence);
    return evidence;
  } catch (error) {
    let finalized = false;
    try {if (!source.destroyed && !source.writableEnded) source.end(); await completed; finalized = true;} catch (_) {}
    const retained = published ? file : partial;
    const saved = fs.existsSync(retained) ? await hashFile(retained).catch(() => ({})) : {};
    const evidence = {file: path.basename(retained), compression: compressed ? 'gzip' : 'none', complete: false,
      ...saved, gzipFinalized: compressed && finalized, payloadComplete: done && finalized,
      chunks, characters, expandedBytes: finalized ? expandedBytes : null, acceptedExpandedBytes: expandedBytes,
      error: String(error.message || error)};
    if (finalized) evidence.expandedSha256 = expandedDigest ?? expanded.digest('hex');
    try {progress('partial', evidence);} catch (_) {}
    error.partialEvidence = evidence;
    throw error;
  }
}

async function persistPageExport(evaluate, directory, options = {}) {
  const evidence = {}, failures = [], partial = {};
  const deadline = options.deadline ?? Date.now() + 600000;
  for (const [name, filename] of [['record', 'record.json.gz'], ['samples', 'samples.json.gz'],
    ['sensorAudit', 'sensor-audit.json.gz'], ['captures', 'captures.json.gz'], ['envelope', 'envelope.json']]) {
    try {evidence[name] = await savePageDataset(evaluate, name, path.join(directory, filename),
      {...options, deadline, compressed: name !== 'envelope'});}
    catch (error) {
      failures.push({dataset: name, error: String(error.message || error)});
      if (error.partialEvidence) partial[name] = error.partialEvidence;
    }
    writeJson(path.join(directory, 'evidence.json'), evidence);
    writeJson(path.join(directory, 'export-status.json'), {complete: false, completedDatasets: Object.keys(evidence), failures, partial});
  }
  const result = {complete: failures.length === 0, completedDatasets: Object.keys(evidence), failures, partial};
  writeJson(path.join(directory, 'export-status.json'), result);
  return {...result, evidence};
}

function evaluateTruth(record, brainSummary = {}, capSeconds = 1200) {
  const failures = [];
  const check = (condition, reason) => { if (!condition) failures.push(reason); };
  check(record?.complete === true, 'incomplete_record');
  const targetDeliveries = (record?.native?.taskDefinition?.deliveries || [])
    .filter(delivery => delivery.objectRole === 'target' && delivery.destinationRole === 'storage');
  const expectedIds = [...new Set(targetDeliveries.flatMap(delivery => delivery.requiredPackageIds))];
  check(expectedIds.length > 0, 'no_evaluator_target_definitions');
  const delivered = new Set(), deliveryEvents = [];
  for (const event of record?.native?.events || []) {
    if (!expectedIds.includes(event.packageId)) continue;
    if (event.type === 'package_delivered') delivered.add(event.packageId);
    else if (event.type === 'package_delivery_revoked') delivered.delete(event.packageId);
    if (['package_delivered', 'package_delivery_revoked'].includes(event.type)) deliveryEvents.push(event);
  }
  const lastSample = record?.native?.samples?.at(-1);
  const finalPositions = expectedIds.map(id => {
    const observed = lastSample?.packages?.find(item => item.id === id);
    const destination = targetDeliveries.find(delivery => delivery.requiredPackageIds.includes(id));
    const distance = observed && Math.hypot(observed.x - destination.destination[0], observed.z - destination.destination[1]);
    return {id, finalSampleTick: lastSample?.tick ?? null, worldPosition: observed ? [observed.x, observed.z] : null,
      destination: destination.destination, distanceWorldUnits: distance ?? null, radiusWorldUnits: destination.radius,
      holding: lastSample?.holding === id, finalInsideStorage: observed !== undefined && lastSample?.holding !== id
        && distance <= destination.radius + 1e-9, deliveredEventActive: delivered.has(id)};
  });
  for (const row of finalPositions) {
    check(row.deliveredEventActive, `no_active_package_delivered_event:${row.id}`);
    check(row.finalInsideStorage, `final_position_outside_storage:${row.id}`);
  }
  const simulationSeconds = (record?.native?.simulationEndTick ?? 0) * (record?.clock?.stepMs ?? 20) / 1000;
  check(simulationSeconds < capSeconds, 'simulation_limit_reached');
  const deniedCalls = (record?.bridgeCalls || []).filter(row => row.type === 'rejected');
  const forbiddenAccepted = (record?.calls || []).filter(row => !PUBLIC_METHODS.includes(row.method));
  check(deniedCalls.length === 0, 'brain_attempted_rejected_bridge_calls');
  check(forbiddenAccepted.length === 0, 'nonwhitelist_call_executed');
  return {schema: 'wm-autonomous-evaluation/v1', evaluationOnly: true,
    success: failures.length === 0, failures, expectedTargetIds: expectedIds,
    deliveredTargetIds: [...delivered].sort(), deliveryEvents, finalPositions, simulationSeconds,
    rejectedCalls: deniedCalls.length, nonwhitelistAcceptedCalls: forbiddenAccepted.length,
    brainSummary, note: 'Success independently requires final truth positions and non-revoked package_delivered record events. No competition score or old strict determinism gate.'};
}

function previousMap05Success(file) {
  // Historical truth-only map-05 results never constitute stage-2 acceptance.
  const previous = readJson(file);
  assert.equal(previous.stage, 'stage-2', 'stage-1 success cannot satisfy the stage-2 gate');
  throw new Error('Stage-2 proof validation is not implemented; ten-layout gate remains closed');
}

function validateStageGate(options) {
  assert.ok(!options.stage2Success, 'Stage-2 proof validation is not implemented; stage-1 success cannot unlock ten layouts');
  assert.ok(options.maps.every(map => map === 'map-05'), 'Stage-2 formal acceptance is required before other layouts');
}

async function runBrain(options, directory, capability, origin, evaluate) {
  const brainDir = path.join(directory, 'brain'); fs.mkdirSync(brainDir);
  const config = {schema: 'autonomous-brain-robot-config/v1', origin, bridge_id: capability.bridgeId,
    client_token: capability.clientToken, task: options.task, simulation_step_ms: 20,
    max_rounds: options.maxRounds, max_simulation_seconds: options.maxSimulationSeconds};
  const args = ['-m', 'autonomous_brain.run', '--out', brainDir];
  if (options.replay) args.push('--replay', options.replay);
  const stdout = fs.createWriteStream(path.join(directory, 'brain-stdout.txt'));
  const stderr = fs.createWriteStream(path.join(directory, 'brain-stderr.txt'));
  const started = Date.now();
  const child = spawn(options.python, args, {cwd: ROOT, env: {...process.env, PYTHONUNBUFFERED: '1'}, stdio: ['pipe', 'pipe', 'pipe']});
  let spawnError = null, exited = false, interrupted = null;
  const completion = new Promise(resolve => {
    child.once('error', error => {spawnError = String(error); exited = true; resolve({code: null, signal: null});});
    child.once('exit', (code, signal) => {exited = true; resolve({code, signal});});
  });
  child.stdout.on('data', bytes => {stdout.write(bytes); process.stderr.write(bytes);});
  child.stderr.on('data', bytes => {stderr.write(bytes); process.stderr.write(bytes);});
  child.stdin.on('error', error => {if (error.code !== 'EPIPE') spawnError = String(error);});
  child.stdin.end(JSON.stringify(config) + '\n');
  try {
  while (!exited) {
    await Promise.race([completion, delay(1000)]);
    if (exited) break;
    // Model service latency does not consume the task's simulation budget.
    // A wall-clock cutoff is an optional diagnostic control, disabled by default.
    if (options.wallTimeoutSeconds > 0 && Date.now() - started >= options.wallTimeoutSeconds * 1000) interrupted = 'driver_wall_timeout';
    else {
      const clock = await evaluate('({tick:deterministicSimulator?.tick ?? 0, stepMs:20, status:competitionSession?.status})');
      if (clock.tick * clock.stepMs >= options.maxSimulationSeconds * 1000) interrupted = 'simulation_limit_reached';
      else if (clock.status !== 'running') interrupted = `backend_stopped:${clock.status}`;
    }
    if (interrupted) {
      child.kill('SIGTERM');
      await Promise.race([completion, delay(3000)]);
      if (!exited) child.kill('SIGKILL');
      break;
    }
  }
  } catch (error) {
    interrupted = `driver_monitor_error:${String(error)}`;
  } finally {
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([completion, delay(3000)]);
      if (!exited) child.kill('SIGKILL');
    }
  }
  const terminal = await completion;
  await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
  return {...terminal, spawnError, interrupted, wallSeconds: (Date.now() - started) / 1000,
    wallTimeoutSeconds: options.wallTimeoutSeconds,
    invocation: {module: 'autonomous_brain.run', output: relative(brainDir), replay: options.replay ? relative(options.replay) : null},
    capabilityPassed: {...config, origin: '<local robot bridge>', bridge_id: '<limited robot capability>', client_token: '<not recorded>'}};
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.replay) {loadLocalLLMConfig(); validateFormalLLMConfig();}
  const gate = verifyPreflightGate({platformRoot: options.platformRoot});
  assert.equal(gate.allPass, true, 'platform two-gate check failed; brain must not start');
  assert.ok(!fs.existsSync(options.out), 'refusing to reuse an output directory');
  assert.ok(fs.existsSync(path.join(ROOT, 'autonomous_brain/run.py')), 'brain module is not ready');
  // Stages one and two run individually on map-05. The independent Python
  // evaluator checks stage-two topology; this driver does not unlock ten layouts.
  validateStageGate(options);
  let map05Passed = false;
  fs.mkdirSync(options.out, {recursive: true});
  const manifest = sourceManifest(options.platformRoot, options);
  const frozenPlatform = gate.run.platform;
  assert.deepEqual(manifest.platform, frozenPlatform, 'selected platform source differs from the rechecked gate evidence');
  writeJson(path.join(options.out, 'manifest.json'), manifest);
  const summary = {schema: VERSION, status: 'running', maps: options.maps, runsPerMap: options.runs,
    maxRounds: options.maxRounds, maxSimulationSeconds: options.maxSimulationSeconds,
    wallTimeoutSeconds: options.wallTimeoutSeconds,
    task: options.task, platformGatePass: true, trials: [], map05SuccessBeforeRun: map05Passed};
  const {createServer} = require(path.join(options.platformRoot, 'server.js'));
  const contract = require(path.join(options.platformRoot, 'robot-bridge-contract.js'));
  assert.deepEqual(contract.METHODS, PUBLIC_METHODS, 'robot whitelist changed');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-autonomous-brain-'));
  const profile = path.join(temp, 'browser'); fs.mkdirSync(profile);
  const server = createServer({dataDir: path.join(temp, 'data'), robotBridgeEnabled: true, robotBridge: {pollTimeoutMs: 1000}});
  const originalPool = new Map(server.mapConfigPools.get(TASK));
  let browser, cdp, evaluate, sessionId, preserveTemp = false;
  try {
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--window-size=1280,900', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync',
      '--metrics-recording-only', '--no-proxy-server', '--disable-features=MediaRouter',
      '--enable-unsafe-swiftshader', '--use-angle=swiftshader', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
    browser.stderr.on('data', () => {});
    const debug = await waitFor(() => {
      if (browser.exitCode !== null) throw new Error(`Chrome exited ${browser.exitCode}`);
      const file = path.join(profile, 'DevToolsActivePort');
      if (!fs.existsSync(file)) return null;
      const [port, suffix] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
      return port && suffix ? `ws://127.0.0.1:${port}${suffix}` : null;
    }, 'Chrome DevTools', 20000);
    cdp = new Cdp(); await cdp.connect(debug);
    const target = await cdp.send('Target.createTarget', {url: 'about:blank'});
    sessionId = (await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: true})).sessionId;
    await cdp.send('Runtime.enable', {}, sessionId); await cdp.send('Page.enable', {}, sessionId);
    evaluate = async (expression, timeoutMs = options.timeoutMs) => {
      const response = await cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true}, sessionId, timeoutMs);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    const navigate = async url => {
      await cdp.send('Page.navigate', {url}, sessionId);
      await waitFor(() => evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`), 'page load');
    };
    await navigate(`${origin}/login.html`);
    const registration = {username: `brain-${crypto.randomBytes(8).toString('hex')}`,
      password: `Brain-${crypto.randomBytes(16).toString('hex')}`, teamName: 'autonomous brain evaluator', group: 'primary'};
    const registered = await evaluate(`(async()=>{const response=await fetch('/api/v1/auth/register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(registration)})});return response.status;})()`);
    assert.equal(registered, 201, 'evaluator account registration failed');
    for (const map of options.maps) {
      if (map !== 'map-05' && !map05Passed) { summary.stoppedBeforeRemainingLayouts = 'map-05 has not succeeded'; break; }
      const store = originalPool.get(map); assert.ok(store, `missing native pool ${map}`);
      for (const key of server.mapConfigPools.get(TASK).keys()) server.mapConfigPools.get(TASK).set(key, store);
      const publication = await store.publicConfig();
      await navigate(`${origin}/`);
      await waitFor(() => evaluate(`typeof RobotBackend === 'object' && typeof activeMission === 'object'
        && document.querySelector('#runButton')?.disabled === false
        && (!document.querySelector('#loadingOverlay') || document.querySelector('#loadingOverlay').classList.contains('is-hidden'))`), 'robot workspace');
      await evaluate(`(async()=>{await refreshPublishedGuangyangMap({config:guangyangConfigForTaskId(${JSON.stringify(TASK)}),apply:false});loadMission('guangyang2');return true;})()`);
      const loaded = await evaluate(`publishedGuangyangMapConfigs.get(${JSON.stringify(TASK)})`);
      assert.deepEqual(loaded.layout, publication.layout, 'selected evaluator layout did not load');
      await evaluate(`(${installEvaluationCapture.toString()})()`);
      for (let run = 1; run <= options.runs; run++) {
        const directory = path.join(options.out, `${map}-run-${run}`); fs.mkdirSync(directory);
        const trial = {map, run, directory: path.basename(directory), success: false,
          maxRounds: options.maxRounds, maxSimulationSeconds: options.maxSimulationSeconds,
          wallTimeoutSeconds: options.wallTimeoutSeconds};
        const errorCursor = cdp.pageErrors.length;
        let started = false, exported = null;
        try {
          await evaluate('globalThis.__brainEvaluationCaptures = []; true');
          const capability = await evaluate(`RobotBackend.start({provenance:{purpose:'autonomous-brain',driverVersion:${JSON.stringify(VERSION)}},limits:{timeLimitSeconds:${options.maxSimulationSeconds},visionEvidenceLimitBytes:null,visionEvidenceFrameLimit:null}})`);
          started = true;
          trial.backendVersion = capability.version;
          trial.process = await runBrain(options, directory, capability, origin, evaluate);
        } catch (error) {trial.error = String(error.stack || error);}
        finally {
          if (started) {
            try { exported = await stopForChunkedExport(evaluate, options.timeoutMs); }
            catch (error) {trial.stopError = String(error.stack || error);}
          }
        }
        // Truth and controller exports are persisted only after the brain exits.
        writeJson(path.join(directory, 'evaluation-map.json'), {map, taskId: TASK, publication,
          note: 'evaluation only; never supplied to the child brain'});
        if (started) {
          // Also attempt independent captures after a failed stop. Each completed
          // dataset survives failures in later datasets; prefixes stay .part.
          preserveTemp = true;
          let saved;
          try {saved = await persistPageExport(evaluate, directory, {requestTimeoutMs: options.timeoutMs});}
          catch (error) {
            trial.exportError = String(error.stack || error);
            saved = {complete: false, completedDatasets: [], partial: {},
              failures: [{dataset: 'export_controller', error: String(error.message || error)}]};
          }
          trial.evidenceExport = {complete: saved.complete, completedDatasets: saved.completedDatasets,
            failures: saved.failures, partial: saved.partial};
          if (saved.complete && !trial.stopError) preserveTemp = false;
          if (saved.complete && exported) {
            try {
              const brainSummaryPath = path.join(directory, 'brain/summary.json');
              const brainSummary = fs.existsSync(brainSummaryPath) ? readJson(brainSummaryPath) : null;
              // Judge in the evaluator page and return only its small result; do not
              // deserialize the whole record again on the host merely to judge it.
              const verdict = await evaluate(`((PUBLIC_METHODS)=>__brainChunkedExport.evaluateRecord(record=>
                (${evaluateTruth.toString()})(record,{},${options.maxSimulationSeconds})))(${JSON.stringify(PUBLIC_METHODS)})`);
              verdict.brainSummary = brainSummary;
              Object.assign(trial, verdict);
              trial.recordFrameCount = exported.recordFrameCount;
              trial.captureCount = exported.captureCount;
              trial.controllerErrors = readJson(path.join(directory, 'envelope.json')).controllerErrors || [];
              if (trial.error || trial.stopError || trial.process?.spawnError || trial.process?.interrupted || trial.process?.code !== 0
                  || trial.controllerErrors.length > 0) {
                trial.success = false; trial.failures.push('execution_or_controller_error');
            }
              if (brainSummary === null) { trial.success = false; trial.failures.push('brain_summary_missing'); }
            } catch (error) {
                trial.success = false; trial.evaluationError = String(error.stack || error);
                trial.failures = [...(trial.failures || []), 'truth_evaluation_failed'];
            }
          } else {
            trial.success = false;
            trial.failures = [...(trial.failures || []), 'evidence_export_incomplete'];
          }
        }
        trial.pageErrors = cdp.pageErrors.slice(errorCursor);
        writeJson(path.join(directory, 'evaluation.json'), trial);
        summary.trials.push(trial);
        if (map === 'map-05' && trial.success) map05Passed = true;
        writeJson(path.join(options.out, 'progress.json'), summary);
        console.error(`BRAIN ${map} run ${run}: ${trial.success ? 'PASS' : 'FAIL'} ${JSON.stringify(trial.failures || trial.error)}`);
        if (trial.stopError || trial.evidenceExport?.complete === false) throw new Error('backend stop/export failed; aborting remaining trials');
      }
    }
    summary.status = 'complete';
  } catch (error) {summary.status = 'failed'; summary.error = String(error.stack || error);}
  finally {
    summary.map05Passed = map05Passed;
    try {
      summary.sourceManifestAfterRun = sourceManifest(options.platformRoot, options);
      summary.sourcesUnchanged = json(manifest) === json(summary.sourceManifestAfterRun);
    } catch (error) {
      // Dependency disappearance/import failure must preserve the failed run
      // and still release the browser/server in this finally block.
      summary.status = 'failed';
      summary.sourceManifestAfterRun = null;
      summary.sourcesUnchanged = false;
      summary.sourceVerificationError = String(error.stack || error);
    }
    summary.success = summary.status === 'complete' && summary.sourcesUnchanged
      && summary.trials.length === options.maps.length * options.runs && summary.trials.every(trial => trial.success);
    if (preserveTemp) summary.preservedTempDirectory = relative(temp);
    writeJson(path.join(options.out, 'summary.json'), summary);
    cdp?.close();
    if (browser && browser.exitCode === null) {
      browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    if (!preserveTemp) fs.rmSync(temp, {recursive: true, force: true});
  }
  console.log(JSON.stringify({out: relative(options.out), status: summary.status, map05Passed, trials: summary.trials.length, success: summary.success}));
  process.exitCode = summary.success ? 0 : 1;
  return summary;
}
module.exports = {VERSION, parseLocalLLMConfig, loadLocalLLMConfig, validateFormalLLMConfig, validateStageGate, worldModelProvenance, parseArgs, installEvaluationCapture,
  installChunkedEvaluationExport, stopForChunkedExport, savePageDataset, persistPageExport,
  evaluateTruth, previousMap05Success, sourceManifest, evaluatorDependencies, runBrain, main};
if (require.main === module) main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
