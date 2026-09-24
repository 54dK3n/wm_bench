#!/usr/bin/env node
"use strict";
// 在环层驱动：起本地平台服务 + headless Chrome（CDP），注册队伍、选任务、运行 Python 程序，
// 采集程序以指定前缀打印的 JSON 行、运行状态、评分面板与队伍获配布局。
// 用法：node inloop_driver.js --mission guangyang2 --program prog.py --out result.json [--prefix GY] [--disable-evidence] [--timeout-ms 900000]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { installVisionTruthCapture } = require("./vision_truth_hook.js");
const { installDemoKeyframesCapture } = require("./demo_keyframes_hook.js");
const { spawn, spawnSync } = require("node:child_process");

const configuredPlatformRoot = process.env.GUANGYANG_PLATFORM_ROOT;
assert.ok(configuredPlatformRoot, "GUANGYANG_PLATFORM_ROOT must point to the external car-python platform");
const PLATFORM_ROOT = path.resolve(configuredPlatformRoot);
const { createServer } = require(path.join(PLATFORM_ROOT, "server.js"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A driver-owned read cache only. It neither hooks nor changes the platform DOM,
// output producer, clock, renderer, camera, physics or recorder.
function terminalDelta(text, request, cache) {
  if (!cache.committed) cache.committed = { id: 0, text: "" };
  if (cache.pending?.id === request.ackId) cache.committed = cache.pending;
  const previous = cache.committed;
  const known = previous.id === request.ackId && previous.text.length === request.cursor;
  const prefix = known && text.startsWith(previous.text);
  // Appending half a UTF-16 surrogate pair changes the previous UTF-8 bytes.
  const splitPair = prefix && request.cursor > 0 && /[\uD800-\uDBFF]/.test(text[request.cursor - 1])
    && /[\uDC00-\uDFFF]/.test(text[request.cursor] || "");
  const mode = prefix && !splitPair ? "append" : "full";
  const id = (cache.nextId || 0) + 1; cache.nextId = id;
  cache.pending = { id, text };
  return { id, baseId: request.ackId, cursor: request.cursor, length: text.length, mode,
    reason: mode === "append" ? null : !known ? "unknown_ack" : !prefix ? "reset_or_prefix_changed" : "unicode_boundary",
    data: mode === "append" ? text.slice(request.cursor) : text };
}

function persistTerminalDelta(filename, state, packet, metrics) {
  assert.equal(packet.baseId, state.ackId, "terminal acknowledgement mismatch");
  assert.equal(packet.cursor, state.text.length, "terminal cursor mismatch");
  assert.ok(packet.mode === "append" || packet.mode === "full", "unknown terminal packet mode");
  assert.equal(typeof packet.data, "string");
  const next = packet.mode === "append" ? state.text + packet.data : packet.data;
  assert.equal(next.length, packet.length, "terminal packet length mismatch");
  const began = performance.now();
  const oldBytes = Buffer.byteLength(state.text, "utf8");
  const actualBytes = fs.existsSync(filename) ? fs.statSync(filename).size : -1;
  const append = packet.mode === "append" && actualBytes === oldBytes;
  const bytes = Buffer.from(append ? packet.data : next, "utf8");
  try {
    if (bytes.length || !append) {
      if (append) fs.appendFileSync(filename, bytes); else fs.writeFileSync(filename, bytes);
      metrics.writeCalls += 1; metrics.writtenBytes += bytes.length;
    }
  } catch (error) {
    // Do not acknowledge a failed/partial write. A later read retries from the
    // committed snapshot and a size mismatch forces a complete replacement.
    if (append) { try { fs.truncateSync(filename, oldBytes); } catch (_error) {} }
    throw error;
  } finally { metrics.writeMs += performance.now() - began; }
  if (packet.mode === "full" && packet.reason !== "final_full_readback") metrics.fullFallbacks += 1;
  metrics.receivedSuffixBytes += Buffer.byteLength(packet.data, "utf8");
  state.text = next; state.ackId = packet.id;
}

function verifyNativeExport(record, archive, archivePath) {
  assert.equal(record.runId, archive.runId);
  assert.deepEqual(record.inputs.filter(row => row.type === "vision_query"), archive.queries);
  assert.equal(record.visionFrames.length, archive.frames.length);
  for (const native of record.visionFrames) {
    const exported = archive.frames.filter(row => row.evidenceId === native.evidenceId);
    assert.equal(exported.length, 1);
    const frame = exported[0];
    for (const [key, value] of Object.entries(native)) if (key !== "pngBase64") assert.deepEqual(frame[key], value);
    const bytes = fs.readFileSync(path.resolve(path.dirname(archivePath), frame.image));
    assert.deepEqual(bytes, Buffer.from(native.pngBase64, "base64"));
    assert.equal(bytes.length, native.byteLength);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), native.sha256);
  }
  return { allPass: true, frames: archive.frames.length, queries: archive.queries.length,
    pngBytes: archive.frames.reduce((sum, frame) => sum + frame.byteLength, 0) };
}

function visionManifestSignature(evidence, errors) {
  return JSON.stringify([evidence.runId, evidence.taskId, evidence.frameCount,
    evidence.frameBytes, evidence.queryCount, evidence.renderTruth, errors]);
}

function demoManifestSignature(evidence, nativeBytes, errors) {
  // Main-view renderCount changes without producing a keyframe. Keep its latest
  // value in memory and persist it at the forced final write.
  return JSON.stringify([evidence.runId, evidence.taskId, evidence.errors,
    evidence.screenshotBytes, nativeBytes, errors]);
}

function parseArgs(argv) {
  const args = { prefix: "GY", timeoutMs: 900000, disableEvidence: false, mission: "guangyang2" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--disable-evidence") args.disableEvidence = true;
    else if (key.startsWith("--")) { args[key.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = argv[i + 1]; i += 1; }
  }
  args.timeoutMs = Number(args.timeoutMs);
  assert.ok(args.demoEvidence === undefined || ["0", "1"].includes(args.demoEvidence), "--demo-evidence 只能为 0 或 1");
  args.demoEvidence = args.demoEvidence === "1";
  assert.ok(args.program, "--program 必填");
  assert.ok(args.out, "--out 必填");
  assert.equal(args.mission, "guangyang2", "本诊断驱动仅运行赛题2（guangyang2）");
  assert.equal(args.disableEvidence, false, "视觉诊断必须保留平台原生20MiB视觉证据，禁止 --disable-evidence");
  return args;
}

function findChrome() {
  const candidates = [
    process.env.CHENLONG_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome", "chromium"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) { if (fs.existsSync(candidate)) return candidate; }
    else if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  throw new Error("No Chrome/Edge executable found");
}

class Cdp {
  constructor(url) { this.url = url; this.ws = null; this.id = 0; this.pending = new Map(); this.metrics = {}; }
  async connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 20000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", event => { clearTimeout(timer); reject(new Error(String(event?.message || "CDP error"))); }, { once: true });
    });
    ws.addEventListener("message", event => {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const parseStarted = performance.now();
      const message = JSON.parse(raw);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        pending.metric.responses += 1;
        pending.metric.responseUtf8Bytes += Buffer.byteLength(raw, "utf8");
        pending.metric.roundTripMs += performance.now() - pending.started;
        pending.metric.parseMs += performance.now() - parseStarted;
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    });
  }
  send(method, params = {}, sessionId = null, label = method) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const metric = this.metrics[label] ||= { requests: 0, responses: 0, requestUtf8Bytes: 0,
        responseUtf8Bytes: 0, roundTripMs: 0, parseMs: 0 };
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      const serialized = JSON.stringify(payload);
      metric.requests += 1; metric.requestUtf8Bytes += Buffer.byteLength(serialized, "utf8");
      this.pending.set(id, { resolve, reject, metric, started: performance.now() });
      this.ws.send(serialized);
    });
  }
  close() { try { this.ws?.close(); } catch (_error) {} }
}

async function devtools(profileDir, browserProcess) {
  const activePortPath = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (browserProcess.exitCode === null) {
      try {
        const lines = (await fs.promises.readFile(activePortPath, "utf8")).trim().split(/\r?\n/);
        const port = Number(lines[0]);
        if (Number.isSafeInteger(port) && port > 0 && lines[1]) return { port, webSocketPath: lines[1] };
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    } else throw new Error("browser exited early");
    await delay(50);
  }
  throw new Error("DevToolsActivePort timeout");
}

function identifyMap(truthDir, taskId, layout) {
  if (!layout) return null;
  const dir = path.join(truthDir, taskId);
  const key = obj => `${obj.cls}:${obj.world[0].toFixed(3)},${obj.world[1].toFixed(3)}`;
  const mine = new Set();
  for (const p of layout.targets || []) mine.add(`target:${p[0].toFixed(3)},${p[1].toFixed(3)}`);
  for (const p of layout.distractors || []) mine.add(`distractor:${p[0].toFixed(3)},${p[1].toFixed(3)}`);
  for (const p of layout.obstacles || []) mine.add(`obstacle:${p[0].toFixed(3)},${p[1].toFixed(3)}`);
  for (const file of fs.readdirSync(dir).filter(f => /^map-\d+\.json$/.test(f)).sort()) {
    const truth = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const theirs = new Set(truth.objects.filter(o => o.cls !== "storage-zone").map(key));
    if (theirs.size === mine.size && [...mine].every(k => theirs.has(k))) return truth.mapId;
  }
  return "unmatched";
}

// 标定：程序每次 observe 打印 {event:"calib_obs", tick, odo:[rightCm, forwardCm, headingDeg], dets:[...]}；
// 这里按 tick 从 record.samples 取场景真值位姿，对每个红/蓝球读数找同类包裹中与读数投影最近的一个，
// 输出真值中心距与方位（右为正，与 observe().bearingDeg 同号）。
const WORLD_UNITS_PER_METER = 8;
const CALIB_CONVENTIONS = { forward: "(-sin h, -cos h)", right: "(cos h, -sin h)", bearingPositive: "right",
  distance: "vehicle centre to package centre, cm", unitsPerMeter: WORLD_UNITS_PER_METER };
const wrapRad = a => Math.atan2(Math.sin(a), Math.cos(a));

function joinCalibTruth(lines, samples) {
  const obsLines = (lines || []).filter(l => l && l.event === "calib_obs");
  if (!obsLines.length || !samples.length) return null;
  const cm = u => u * 100 / WORLD_UNITS_PER_METER;
  const start = samples.find(s => s.tick === 0) || samples[0];
  const byTick = new Map();
  for (const s of samples) byTick.set(s.tick, s);  // 同 tick 多条时取最后一条（动作结束强制记录）
  const rows = [];
  for (const line of obsLines) {
    let sample = byTick.get(line.tick), tickMatch = "exact";
    if (!sample) {
      let best = null;
      for (const s of samples) if (best === null || Math.abs(s.tick - line.tick) < Math.abs(best.tick - line.tick)) best = s;
      sample = best; tickMatch = `nearest:${best.tick - line.tick}`;
    }
    const h = sample.heading;
    const fwd = [-Math.sin(h), -Math.cos(h)], right = [Math.cos(h), -Math.sin(h)];
    // 场景位姿换算成里程计，与程序同 tick 读到的里程计比对
    const f0 = [-Math.sin(start.heading), -Math.cos(start.heading)], r0 = [Math.cos(start.heading), -Math.sin(start.heading)];
    const dx0 = sample.x - start.x, dz0 = sample.z - start.z;
    const odoTruth = [cm(dx0 * r0[0] + dz0 * r0[1]), cm(dx0 * f0[0] + dz0 * f0[1]), wrapRad(h - start.heading) * 180 / Math.PI];
    const odo = line.odo || [];
    const poseCheck = { dPosCm: Number(Math.hypot(odoTruth[0] - odo[0], odoTruth[1] - odo[1]).toFixed(3)),
      dHeadingDeg: Number((((odoTruth[2] - odo[2]) + 540) % 360 - 180).toFixed(3)), speed: sample.speed };
    for (const det of line.dets || []) {
      const b = Number(det.bearingDeg) * Math.PI / 180, d = Number(det.distanceCm);
      // 读数投影（场景坐标）
      const px = sample.x + (d * WORLD_UNITS_PER_METER / 100) * (Math.cos(b) * fwd[0] + Math.sin(b) * right[0]);
      const pz = sample.z + (d * WORLD_UNITS_PER_METER / 100) * (Math.cos(b) * fwd[1] + Math.sin(b) * right[1]);
      const candidates = (sample.packages || []).filter(p => p.role === det.category && p.id !== sample.holding).map(p => {
        const dx = p.x - sample.x, dz = p.z - sample.z;
        const f = dx * fwd[0] + dz * fwd[1], r = dx * right[0] + dz * right[1];
        return { id: p.id, truthDistanceCm: cm(Math.hypot(dx, dz)), truthBearingDeg: Math.atan2(r, f) * 180 / Math.PI,
          truthForwardCm: cm(f), truthRightCm: cm(r), projErrCm: cm(Math.hypot(p.x - px, p.z - pz)) };
      }).sort((a, b2) => a.projErrCm - b2.projErrCm);
      if (!candidates.length) continue;
      const best = candidates[0];
      const round = v => Number(v.toFixed(2));
      rows.push({ n: line.n, station: line.station, anchor: line.anchor, tag: line.tag, tick: line.tick, tickAfter: line.tickAfter,
        tickMatch, sampleTick: sample.tick, poseCheck, category: det.category, distanceCm: d, bearingDeg: Number(det.bearingDeg),
        confidence: det.confidence, packageId: best.id, truthDistanceCm: round(best.truthDistanceCm), truthBearingDeg: round(best.truthBearingDeg),
        truthForwardCm: round(best.truthForwardCm), truthRightCm: round(best.truthRightCm), projErrCm: round(best.projErrCm),
        secondProjErrCm: candidates[1] ? round(candidates[1].projErrCm) : null });
    }
  }
  return rows;
}

const MISSION_TASK = { guangyang1: "R2-GYI-MVP-01", guangyang2: "R2-GYI-MVP-02", guangyang3: "R2-GYI-MVP-03" };
const MISSION_TITLE = { guangyang1: "任务1", guangyang2: "任务2", guangyang3: "任务3" };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = message => console.error(`INLOOP ${new Date().toISOString()} ${message}`);
  const source = await fs.promises.readFile(args.program, "utf8");
  await fs.promises.mkdir(path.dirname(args.out), { recursive: true });
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wm-inloop-"));
  const dataDir = path.join(tempRoot, "data");
  const profileDir = path.join(tempRoot, "chrome-profile");
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.mkdir(profileDir, { recursive: true });
  const server = createServer({ dataDir });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browserProcess = null, client = null, sessionId = null;
  const result = { mission: args.mission, taskId: MISSION_TASK[args.mission], program: args.program, startedAt: new Date().toISOString() };
  const hostIO = { schema: "wm-host-io/v1", clock: "host monotonic performance.now; no simulation clock changes",
    terminal: { writeCalls: 0, writtenBytes: 0, writeMs: 0, receivedSuffixBytes: 0,
      fullFallbacks: 0, pageReadMs: 0, errors: [] },
    manifests: { visionWrites: 0, visionSkippedUnchanged: 0, demoWrites: 0,
      demoSkippedUnchanged: 0, writtenBytes: 0, writeMs: 0 }, evaluateTimeouts: [] };
  const writeManifest = async (filename, archive, kind) => {
    const started = performance.now(); const bytes = Buffer.from(JSON.stringify(archive, null, 1), "utf8");
    await fs.promises.writeFile(filename, bytes);
    hostIO.manifests[`${kind}Writes`] += 1;
    hostIO.manifests.writtenBytes += bytes.length; hostIO.manifests.writeMs += performance.now() - started;
  };
  try {
    browserProcess = spawn(findChrome(), [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`,
      "--window-size=1280,900", "--force-device-scale-factor=1", "--enable-automation",
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--disable-sync",
      "--metrics-recording-only", "--no-proxy-server", "--disable-features=MediaRouter",
      "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const debug = await devtools(profileDir, browserProcess);
    client = new Cdp(`ws://127.0.0.1:${debug.port}${debug.webSocketPath}`);
    await client.connect();
    const target = await client.send("Target.createTarget", { url: "about:blank" });
    sessionId = (await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    let evalCapMs = Infinity;  // 页面确认冻结后把所有收尾读取压到 15 s，避免空等半小时
    const evaluate = async (expression, awaitPromise = false, evalTimeoutMs = 600000, label = "Runtime.evaluate") => {
      evalTimeoutMs = Math.min(evalTimeoutMs, evalCapMs);
      let timer;
      let r;
      try { r = await Promise.race([
        client.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true }, sessionId, label),
        new Promise((_resolve, reject) => { timer = setTimeout(() => {
          hostIO.evaluateTimeouts.push({ at: new Date().toISOString(), label, timeoutMs: evalTimeoutMs });
          reject(new Error(`Runtime.evaluate timeout after ${evalTimeoutMs} ms`));
        }, evalTimeoutMs); })
      ]); } finally { clearTimeout(timer); }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    // Read the platform's existing PNG evidence and exact query bindings. No extra
    // frame is captured, no truth enters the task, and no recorder budget changes.
    const visionPath = path.resolve(args.out.replace(/\.json$/, "") + ".vision.json");
    const visionDir = visionPath.replace(/\.json$/, "");
    const visionArchive = { schema: "wm-vision-evidence/v1", taskId: result.taskId,
      source: "native record.visionFrames and record.inputs; no additional camera queries",
      evidenceBudgetBytes: 20 * 1024 * 1024, frames: [], queries: [], exportErrors: [] };
    let lastVisionFrameSeq = -1, lastVisionQuerySeq = -1, lastVisionManifestSignature = null;
    const exportVisionEvidence = async (force = false) => {
      const evidence = await evaluate(`(() => {
        let r = typeof latestCompetitionRecord !== "undefined" ? latestCompetitionRecord : null;
        if (!r) { const s = typeof competitionSession !== "undefined" ? competitionSession : globalThis.competitionSession;
          r = s && s.recorder ? s.recorder.record : null; }
        if (!r) return null;
        return { runId: r.runId, taskId: r.taskId,
          cameraDefinition: globalThis.CompetitionCore?.CAMERA_DEFINITION || null,
          cameraDefinitionHash: globalThis.CompetitionCore?.CAMERA_DEFINITION_HASH || null,
          detectorDefinitionHash: globalThis.CompetitionCore?.DETECTOR_DEFINITION_HASH || null,
          frameCount: (r.visionFrames || []).length,
          frameBytes: (r.visionFrames || []).reduce((n, f) => n + (f.byteLength || 0), 0),
          queryCount: (r.inputs || []).filter(q => q.type === "vision_query").length,
          frames: (r.visionFrames || []).filter(f => f.seq > ${lastVisionFrameSeq}),
          queries: (r.inputs || []).filter(q => q.type === "vision_query" && q.seq > ${lastVisionQuerySeq}),
          renderTruth: globalThis.__wmDriverVisionTruth || null };
      })()`, false, 120000, "vision_incremental_read");
      if (!evidence) return;
      assert.equal(evidence.taskId, MISSION_TASK.guangyang2, "诊断证据必须来自赛题2");
      if (visionArchive.runId) assert.equal(evidence.runId, visionArchive.runId, "视觉证据runId不能混局");
      const signature = visionManifestSignature(evidence, visionArchive.exportErrors);
      if (!force && !evidence.frames.length && !evidence.queries.length && signature === lastVisionManifestSignature) {
        hostIO.manifests.visionSkippedUnchanged += 1; return;
      }
      Object.assign(visionArchive, { runId: evidence.runId, cameraDefinition: evidence.cameraDefinition,
        cameraDefinitionHash: evidence.cameraDefinitionHash, detectorDefinitionHash: evidence.detectorDefinitionHash,
        nativeFrameCount: evidence.frameCount, nativeFrameBytes: evidence.frameBytes,
        nativeQueryCount: evidence.queryCount, renderTruth: evidence.renderTruth });
      await fs.promises.mkdir(visionDir, { recursive: true });
      for (const frame of evidence.frames) {
        const payload = frame.pngBase64 ?? frame.payloadBase64 ?? frame.payload ?? frame.dataUrl;
        assert.equal(typeof payload, "string", `frame ${frame.evidenceId} has no PNG payload`);
        const bytes = Buffer.from(payload.replace(/^data:image\/png;base64,/, ""), "base64");
        const digest = crypto.createHash("sha256").update(bytes).digest("hex");
        assert.equal(digest, frame.sha256, `frame ${frame.evidenceId} PNG SHA256 mismatch`);
        assert.equal(bytes.length, frame.byteLength, `frame ${frame.evidenceId} PNG byte length mismatch`);
        const filename = `evidence-${String(frame.seq).padStart(6, "0")}-tick-${frame.tick}.png`;
        await fs.promises.writeFile(path.join(visionDir, filename), bytes);
        const metadata = { ...frame, image: path.join(path.basename(visionDir), filename), exportedSha256: digest };
        for (const field of ["pngBase64", "payloadBase64", "payload", "dataUrl"]) delete metadata[field];
        visionArchive.frames.push(metadata);
        lastVisionFrameSeq = frame.seq;
      }
      for (const query of evidence.queries) {
        visionArchive.queries.push(query);
        lastVisionQuerySeq = query.seq;
      }
      const byEvidence = new Map(visionArchive.frames.map(frame => [frame.evidenceId, frame]));
      visionArchive.observeBindings = visionArchive.queries.filter(q => q.method === "observe").map(query => {
        const frame = byEvidence.get(query.evidenceId);
        return { querySeq: query.seq, queryTick: query.tick, frameId: query.frameId, evidenceId: query.evidenceId,
          frameSeq: frame?.seq ?? null, frameTick: frame?.tick ?? null, image: frame?.image ?? null,
          bound: !!frame && frame.frameId === query.frameId && frame.seq < query.seq };
      });
      visionArchive.validation = {
        exportedFrameCount: visionArchive.frames.length,
        exportedFrameBytes: visionArchive.frames.reduce((total, frame) => total + frame.byteLength, 0),
        allNativeFramesExported: visionArchive.frames.length === evidence.frameCount,
        allNativeQueriesExported: visionArchive.queries.length === evidence.queryCount,
        allObserveFramesBound: visionArchive.observeBindings.every(binding => binding.bound),
        nativeBytesWithinBudget: evidence.frameBytes <= visionArchive.evidenceBudgetBytes
      };
      visionArchive.validation.exportedBytesMatchNative = visionArchive.validation.exportedFrameBytes === evidence.frameBytes;
      const truths = new Map((visionArchive.renderTruth?.frames || [])
        .filter(item => item.runId === visionArchive.runId).map(item => [item.evidenceId, item]));
      visionArchive.validation.allNativeFramesHaveExactRenderTruth = visionArchive.frames.every(frame => {
        const truth = truths.get(frame.evidenceId);
        return truth?.exactRenderState === true && truth.frameId === frame.frameId
          && truth.evidenceSeq === frame.seq && truth.imageSha256 === frame.sha256
          && truth.evidenceTick === frame.tick && truth.evidenceStateRevision === frame.stateRevision;
      });
      visionArchive.validation.renderTruthErrors = visionArchive.renderTruth?.errors?.length ?? null;
      visionArchive.exportedAt = new Date().toISOString();
      await writeManifest(visionPath, visionArchive, "vision");
      lastVisionManifestSignature = signature;
      result.visionEvidenceFile = visionPath;
    };
    const tryExportVisionEvidence = async (force = false) => {
      try { await exportVisionEvidence(force); }
      catch (error) {
        const message = String(error.message || error);
        visionArchive.exportErrors.push({ at: new Date().toISOString(), message });
        result.visionExportErrors = visionArchive.exportErrors;
        log(`vision export failed: ${message}`);
        try { await writeManifest(visionPath, visionArchive, "vision"); result.visionEvidenceFile = visionPath; }
        catch (writeError) { log(`vision error ledger write failed: ${writeError.message || writeError}`); }
      }
    };
    const demoPath = path.resolve(args.out.replace(/\.json$/, "") + ".demo.json");
    const demoDir = demoPath.replace(/\.json$/, "");
    const demoArchive = { schema: "wm-demo-evidence/v1", frames: [], exportErrors: [],
      evidenceBudgetBytes: 20 * 1024 * 1024,
      budgetEnforcedOn: "native_vision_only",
      budgetScope: "stage 0: native vision PNG cap unchanged; native plus at most four demo PNG bytes reported, not an extra stage-0 gate; JSON/base64 copies are not extra images" };
    let lastDemoIndex = 0, lastDemoManifestSignature = null;
    const tryExportDemoEvidence = async (force = false) => {
      if (!args.demoEvidence) return;
      try {
        const evidence = await evaluate(`(() => {
          const d = globalThis.__wmDriverDemoKeyframes;
          if (!d) return null;
          const {frames, ...metadata} = d;
          return {...metadata, frames: frames.filter(f => f.index > ${lastDemoIndex})};
        })()`, false, 120000, "demo_incremental_read");
        if (!evidence) throw new Error("demo keyframe ledger unavailable");
        if (evidence.taskId) assert.equal(evidence.taskId, MISSION_TASK.guangyang2);
        if (demoArchive.runId) assert.equal(evidence.runId, demoArchive.runId, "demo evidence runId不能混局");
        Object.assign(demoArchive, { runId: evidence.runId, taskId: evidence.taskId,
          source: evidence.source, hookErrors: evidence.errors, nativeMainRenderCount: evidence.renderCount,
          hookScreenshotBytes: evidence.screenshotBytes });
        const signature = demoManifestSignature(evidence, visionArchive.nativeFrameBytes, demoArchive.exportErrors);
        if (!force && !evidence.frames.length && signature === lastDemoManifestSignature) {
          hostIO.manifests.demoSkippedUnchanged += 1; return;
        }
        await fs.promises.mkdir(demoDir, { recursive: true });
        for (const frame of evidence.frames) {
          const bytes = Buffer.from(frame.pngBase64, "base64");
          assert.equal(bytes.length, frame.byteLength, "demo PNG byte length mismatch");
          assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "demo PNG signature mismatch");
          const digest = crypto.createHash("sha256").update(bytes).digest("hex");
          const filename = `event-${String(frame.eventSeq).padStart(6, "0")}-${frame.eventType}-tick-${frame.captureTick}.png`;
          await fs.promises.writeFile(path.join(demoDir, filename), bytes);
          const { pngBase64, ...metadata } = frame;
          demoArchive.frames.push({ ...metadata, image: path.join(path.basename(demoDir), filename), sha256: digest });
          lastDemoIndex = frame.index;
        }
        demoArchive.nativeFrameBytes = visionArchive.nativeFrameBytes ?? 0;
        demoArchive.screenshotBytes = demoArchive.frames.reduce((n, frame) => n + frame.byteLength, 0);
        demoArchive.combinedImageBytes = demoArchive.nativeFrameBytes + demoArchive.screenshotBytes;
        demoArchive.combinedImagesWithinBudget = demoArchive.combinedImageBytes <= demoArchive.evidenceBudgetBytes;
        demoArchive.allScreenshotBytesExported = demoArchive.screenshotBytes === evidence.screenshotBytes;
        demoArchive.exportedAt = new Date().toISOString();
        await writeManifest(demoPath, demoArchive, "demo");
        lastDemoManifestSignature = signature;
        result.demoEvidenceFile = demoPath;
      } catch (error) {
        demoArchive.exportErrors.push({ at: new Date().toISOString(), message: String(error.message || error) });
        log(`demo export failed: ${error.message || error}`);
        try { await writeManifest(demoPath, demoArchive, "demo"); result.demoEvidenceFile = demoPath; }
        catch (writeError) { log(`demo error ledger write failed: ${writeError.message || writeError}`); }
      }
    };
    const waitFor = async (expression, accept, label, timeoutMs = 30000, intervalMs = 100) => {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await evaluate(expression);
        if (accept(last)) return last;
        await delay(intervalMs);
      }
      throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 300)}`);
    };
    const navigate = async url => {
      await client.send("Page.navigate", { url }, sessionId);
      await waitFor("document.readyState", v => v === "complete", url, 20000, 50);
    };
    const username = (args.username || `wmb${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`).slice(0, 30);
    const password = `Wm-Bench-${Date.now().toString(36)}-2026`;
    log("navigating login");
    await navigate(`${origin}/login.html`);
    const registration = await evaluate(`(async () => {
      const response = await fetch("/api/v1/auth/register", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)}, teamName: ${JSON.stringify(args.teamName || "WM acceptance bench")}, group: "primary" }) });
      return { status: response.status, body: await response.text() };
    })()`, true);
    if (registration.status !== 201) throw new Error(`register failed: ${registration.status} ${registration.body}`);
    result.username = username;
    result.mapConfig = await evaluate(`(async () => {
      const out = {};
      for (const p of ${JSON.stringify(args.demoEvidence ? [`/api/v1/map-config/${MISSION_TASK[args.mission]}`] : ["/api/v1/map-config", `/api/v1/map-config/${MISSION_TASK[args.mission]}`])}) {
        try { const r = await fetch(p); out[p] = { status: r.status, body: await r.json() }; } catch (e) { out[p] = { error: String(e) }; }
      }
      return out;
    })()`, true);
    if (args.wantMaps) {
      const truthDir = process.env.WM_TRUTH_DIR || path.join(process.env.HOME || "", "wm_bench", "artifacts", "truth");
      const body = result.mapConfig[`/api/v1/map-config/${MISSION_TASK[args.mission]}`]?.body;
      const assigned = identifyMap(truthDir, MISSION_TASK[args.mission], body?.layout);
      result.assignedMap = assigned;
      const wanted = String(args.wantMaps).split(",").map(s => s.trim()).filter(Boolean);
      if (!wanted.includes(assigned)) {
        await fs.promises.mkdir(path.dirname(args.out), { recursive: true });
        await fs.promises.writeFile(args.out, JSON.stringify({ ...result, skipped: true, reason: `assigned ${assigned} not wanted` }, null, 1), "utf8");
        console.log(JSON.stringify({ out: args.out, skipped: true, assignedMap: assigned }));
        process.exitCode = 3;
        return;
      }
      log(`assigned layout ${assigned} is wanted`);
    }
    log("navigating workspace");
    await navigate(`${origin}/`);
    await waitFor(`(() => { const b = document.querySelector("#runButton"); const o = document.querySelector("#loadingOverlay");
      return { ready: typeof activeMission === "object" && b && b.disabled === false && (o === null || o.classList.contains("is-hidden")) }; })()`,
      v => v?.ready === true, "simulator ready", 180000, 200);
    const selected = await evaluate(`(() => { const s = document.querySelector("#sceneSelect"); s.value = ${JSON.stringify(args.mission)}; s.dispatchEvent(new Event("change", { bubbles: true })); return s.value; })()`);
    assert.equal(selected, args.mission);
    await waitFor("typeof activeMission === 'undefined' ? '' : activeMission.title",
      v => typeof v === "string" && v.includes(MISSION_TITLE[args.mission]), "mission title", 15000, 100);
    result.visionTruthHook = await evaluate(`(${installVisionTruthCapture.toString()})()`);
    if (args.demoEvidence) result.demoKeyframesHook = await evaluate(`(${installDemoKeyframesCapture.toString()})()`);
    if (args.disableEvidence) {
      await evaluate(`(() => { const Core = globalThis.CompetitionCore; const proto = Core && Core.CompetitionSession ? Core.CompetitionSession.prototype : null;
        if (proto && typeof proto.addVisionEvidence === "function") proto.addVisionEvidence = function () { return null; }; return true; })()`);
      result.visionEvidenceDisabled = true;
      log("vision evidence ledger disabled (score not valid for submission)");
    }
    await evaluate(`(() => { const e = document.querySelector("#pythonEditor"); e.value = ${JSON.stringify(source)}; e.dispatchEvent(new Event("input", { bubbles: true })); return e.value.length; })()`);
    log("running program");
    const t0 = Date.now();
    await evaluate(`document.querySelector("#runButton").click()`);
    const donePrefix = `${args.prefix}_DONE`;
    let timedOut = false;
    let stallReason = null;
    const STALL_MS = 120000, TIMELINE_MS = 30000;
    // 每 0.5 s 轮询：运行状态、输出长度、可见的 Python 反馈、仿真 tick、车辆真值位姿、包裹真值。
    const terminalState = { text: "", ackId: 0 };
    const partialPath = args.out.replace(/\.json$/, "") + ".partial.txt";
    const statusExpr = `(() => {
      const state = document.querySelector("#competitionRunState")?.textContent?.trim() || "";
      const outputReadStarted = performance.now();
      const output = document.querySelector("#pythonOutputContent")?.textContent || "";
      const logPacket = (${terminalDelta.toString()})(output, __WM_DRIVER_LOG_REQUEST__,
        globalThis.__wmDriverTerminalReadCache ||= {});
      const outputReadMs = performance.now() - outputReadStarted;
      const fb = document.querySelector("#pythonFeedback");
      const feedbackVisible = !!fb && fb.hidden !== true;
      let tick = null, simElapsedMs = null, sessionStatus = null, sampleCount = null, eventCount = null;
      try { tick = (typeof deterministicSimulator !== "undefined" && deterministicSimulator) ? deterministicSimulator.tick : null; } catch (e) {}
      try { const s = globalThis.competitionSession || null; if (s) { sessionStatus = s.status; simElapsedMs = typeof s.elapsedMs === "function" ? s.elapsedMs() : null;
        const rec = s.recorder && s.recorder.record; if (rec) { sampleCount = Array.isArray(rec.samples) ? rec.samples.length : null; eventCount = Array.isArray(rec.events) ? rec.events.length : null; } } } catch (e) {}
      let pose = null; try { pose = (typeof robotPose === "object" && robotPose) ? { x: robotPose.x, z: robotPose.z, heading: robotPose.heading } : null; } catch (e) {}
      let holding = null; try { holding = typeof heldPackageId === "undefined" ? null : heldPackageId; } catch (e) {}
      let packages = null; try { packages = typeof getTopPackageMeshes === "function" ? getTopPackageMeshes().map(m => ({ id: m.userData?.packageId ?? m.userData?.id ?? m.name ?? null, x: m.position.x, z: m.position.z })) : null; } catch (e) {}
      return { state, outputLength: output.length, logPacket, outputReadMs, done: output.includes(${JSON.stringify(donePrefix)}),
        feedbackVisible, feedbackMessage: feedbackVisible ? (document.querySelector("#pythonFeedbackMessage")?.textContent?.trim() || "") : "",
        tick, simElapsedMs, sessionStatus, sampleCount, eventCount, pose, holding, packages };
    })()`;
    const isEnded = v => !!v && (v.done === true || v.state === "运行已结束" || v.state === "任务完成");
    const timeline = [];
    let cachedOutput = "";
    let last = null;
    let lastProgress = undefined, lastProgressAt = Date.now(), lastOutputLen = -1, lastOutputAt = Date.now(), lastTimelineAt = 0, lastOkAt = Date.now();
    const deadline = Date.now() + args.timeoutMs;
    while (Date.now() < deadline) {
      let cur = null;
      try { cur = await evaluate(statusExpr.replace("__WM_DRIVER_LOG_REQUEST__", JSON.stringify({
        ackId: terminalState.ackId, cursor: terminalState.text.length })), false, 30000, "terminal_status_delta");
        lastOkAt = Date.now(); }
      catch (error) {
        if (Date.now() - lastOkAt > STALL_MS) { stallReason = "sim_frozen"; evalCapMs = 15000; log(`sim_frozen: page unresponsive for ${STALL_MS / 1000} s (${error.message})`); break; }
        await delay(2000); continue;
      }
      last = cur;
      // 输出缓存：页面冻结后仍能保留已打印的行
      hostIO.terminal.pageReadMs += cur.outputReadMs || 0;
      try { persistTerminalDelta(partialPath, terminalState, cur.logPacket, hostIO.terminal);
        cachedOutput = terminalState.text;
      } catch (error) { hostIO.terminal.errors.push({ at: new Date().toISOString(), message: String(error.message || error) }); }
      // Check native evidence even when the program emits no new terminal text.
      await tryExportVisionEvidence();
      await tryExportDemoEvidence();
      const now = Date.now();
      const progress = cur.tick ?? cur.sampleCount ?? cur.simElapsedMs;
      if (progress !== lastProgress) { lastProgress = progress; lastProgressAt = now; }
      if (cur.outputLength !== lastOutputLen) { lastOutputLen = cur.outputLength; lastOutputAt = now; }
      if (cur.feedbackVisible && cur.feedbackMessage && !result.pythonFeedback) {
        result.pythonFeedback = { at: new Date().toISOString(), wallSeconds: (now - t0) / 1000, message: cur.feedbackMessage };
        log(`python feedback visible: ${cur.feedbackMessage.slice(0, 300)}`);
      }
      if (now - lastTimelineAt >= TIMELINE_MS) {
        lastTimelineAt = now;
        timeline.push({ wallSeconds: Math.round((now - t0) / 1000), tick: cur.tick, simElapsedMs: cur.simElapsedMs, sessionStatus: cur.sessionStatus,
          sampleCount: cur.sampleCount, eventCount: cur.eventCount, outputLength: cur.outputLength, pose: cur.pose, holding: cur.holding, packages: cur.packages });
        log(`t=${Math.round((now - t0) / 1000)}s tick=${cur.tick} samples=${cur.sampleCount} events=${cur.eventCount} out=${cur.outputLength} pose=${JSON.stringify(cur.pose)} holding=${JSON.stringify(cur.holding)}`);
      }
      if (isEnded(cur)) break;
      if (now - lastProgressAt > STALL_MS) { stallReason = "sim_frozen"; log(`sim_frozen: tick/progress ${JSON.stringify(progress)} unchanged for ${STALL_MS / 1000} s`); break; }
      if (now - lastOutputAt > STALL_MS) { stallReason = "program_stalled"; log(`program_stalled: tick advancing (${cur.tick}) but no program output for ${STALL_MS / 1000} s`); break; }
      await delay(500);
    }
    if (!stallReason && !isEnded(last)) { timedOut = true; log("program end timeout"); }
    result.timedOut = timedOut;
    result.stallReason = stallReason;
    result.timeline = timeline;
    result.wallSeconds = (Date.now() - t0) / 1000;
    if (stallReason || timedOut) {
      // 主动结束运行，让平台提交最终 record（含 events/samples）。
      try { await evaluate(`document.querySelector("#stopButton")?.click()`, false, 30000); } catch (e) { log(`stop click failed: ${e.message}`); }
      const stopDeadline = Date.now() + 30000;
      while (Date.now() < stopDeadline) {
        try { const st = await evaluate(`document.querySelector("#competitionRunState")?.textContent?.trim() || ""`, false, 15000); if (st !== "计时运行中") { log(`run state after stop: ${st}`); break; } } catch (e) { log(`stop wait: ${e.message}`); break; }
        await delay(500);
      }
    }
    const runResult = last || { state: "unknown" };
    // 若程序已打印 DONE 但状态仍在运行，再等待状态收敛（最多 60 s）
    await delay(1500);
    let output = cachedOutput;
    try { output = await evaluate(`document.querySelector("#pythonOutputContent")?.textContent || ""`, false, 60000, "terminal_final_full"); }
    catch (e) { log(`final output read failed (${e.message}); using cached output (${cachedOutput.length} chars)`); result.outputFromCache = true; }
    try {
      const beforeFinalSyncExact = Buffer.from(cachedOutput, "utf8").equals(Buffer.from(output, "utf8"));
      persistTerminalDelta(partialPath, terminalState, { id: terminalState.ackId + 1,
        baseId: terminalState.ackId, cursor: terminalState.text.length, length: output.length,
        mode: "full", data: output, reason: "final_full_readback" }, hostIO.terminal);
      const expected = Buffer.from(output, "utf8"), saved = fs.readFileSync(partialPath);
      hostIO.terminal.finalVerification = { allPass: !result.outputFromCache && expected.equals(saved),
        finalFullReadAvailable: !result.outputFromCache, beforeFinalSyncExact,
        finalFullReplacement: true,
        mismatchKind: beforeFinalSyncExact ? null : output.startsWith(cachedOutput) ? "additional_final_output" : "prefix_changed_full_fallback",
        bytes: saved.length, sha256: crypto.createHash("sha256").update(saved).digest("hex") };
      assert.ok(expected.equals(saved), "final terminal UTF-8 byte comparison failed");
    } catch (error) {
      hostIO.terminal.errors.push({ at: new Date().toISOString(), message: String(error.message || error) });
      hostIO.terminal.finalVerification = { allPass: false, error: String(error.message || error) };
    }
    result.runState = runResult.state;
    // 只有 #pythonFeedback 非 hidden 时才算真正的 Python 反馈；标题"Python 代码有问题"是静态文案。
    result.feedbackText = result.pythonFeedback ? result.pythonFeedback.message : "";
    result.lines = [];
    for (const line of output.split("\n")) {
      if (line.startsWith(`${args.prefix} `)) {
        try { result.lines.push(JSON.parse(line.slice(args.prefix.length + 1))); } catch (e) { result.lines.push({ parseError: line.slice(0, 200) }); }
      }
    }
    result.outputTail = output.slice(-3000);
    try { result.score = await evaluate(`(() => { const text = s => document.querySelector(s)?.textContent?.trim() || ""; return {
      total: text("#competitionScore"), task: text("#competitionTaskScore"), rule: text("#competitionRuleScore"), auto: text("#competitionAutoScore"),
      efficiency: text("#competitionEfficiencyScore"), mission: text("#missionProgressValue"), runState: text("#competitionRunState"),
      collisions: text("#competitionCollisionCount"), violations: text("#competitionRuleViolations"), elapsed: text("#competitionElapsed") }; })()`); } catch (e) { result.score = { error: String(e.message || e) }; log(`result.score read failed: ${e.message}`); }
    try { result.record = await evaluate(`(() => { try {
      let r = typeof latestCompetitionRecord !== "undefined" ? latestCompetitionRecord : null;
      let source = "latestCompetitionRecord";
      if (!r) { const s = globalThis.competitionSession; r = s && s.recorder && s.recorder.record ? s.recorder.record : null; source = r ? "session.recorder.record" : null; }
      if (!r) return null;
      const pick = (o, keys) => { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out; };
      const visionFrames = Array.isArray(r.visionFrames) ? r.visionFrames : [];
      const inputs = Array.isArray(r.inputs) ? r.inputs : [];
      const frameBytes = visionFrames.reduce((sum, f) => sum + (Number(f && f.byteLength) || 0), 0);
      const frameBase64Bytes = visionFrames.reduce((sum, f) => sum + String((f && (f.pngBase64 || f.payloadBase64)) || "").length, 0);
      return {
        source,
        keys: Object.keys(r),
        events: Array.isArray(r.events) ? r.events : [],
        sampleCount: Array.isArray(r.samples) ? r.samples.length : 0,
        top: pick(r, ["schemaVersion", "runId", "taskId", "mapId", "mapVersion", "collisionCount", "ruleViolations", "score", "result", "summary", "quality", "outcome", "finalScore", "elapsedMs", "durationMs"]),
        vision: {
          frameCount: visionFrames.length,
          frameBytes,
          frameBase64Bytes,
          queryCount: inputs.filter(item => item && item.type === "vision_query").length,
          inputCount: inputs.length
        }
      };
    } catch (e) { return { error: String(e) }; } })()`, false, 120000); } catch (e) { result.record = { error: String(e.message || e) }; log(`result.record read failed: ${e.message}`); }
    try {
      const samples = await evaluate(`(() => { try {
        let r = typeof latestCompetitionRecord !== "undefined" ? latestCompetitionRecord : null;
        if (!r) { const s = globalThis.competitionSession; r = s && s.recorder && s.recorder.record ? s.recorder.record : null; }
        return r && Array.isArray(r.samples) ? r.samples : null; } catch (e) { return null; } })()`, false, 120000);
      if (samples) {
        const samplesPath = args.out.replace(/\.json$/, "") + ".samples.json";
        await fs.promises.mkdir(path.dirname(samplesPath), { recursive: true });
        await fs.promises.writeFile(samplesPath, JSON.stringify(samples), "utf8");
        result.samplesFile = samplesPath;
        log(`saved ${samples.length} samples to ${samplesPath}`);
        const calibRows = joinCalibTruth(result.lines, samples);
        if (calibRows) {
          const calibPath = args.out.replace(/\.json$/, "") + ".calib.json";
          await fs.promises.writeFile(calibPath, JSON.stringify({ schema: "wm-range-calib/v1", assignedMap: result.assignedMap || null,
            program: args.program, conventions: CALIB_CONVENTIONS, rows: calibRows }, null, 1), "utf8");
          result.calibFile = calibPath;
          log(`joined ${calibRows.length} calib detections to ${calibPath}`);
        }
      }
    } catch (e) { log(`samples save failed: ${e.message}`); }
    try { result.sessionSummary = await evaluate(`(() => { try {
      const s = globalThis.competitionSession || globalThis.activeCompetitionSession || null;
      if (!s) return null; const summary = typeof s.summary === "function" ? s.summary() : (s.state || null);
      return summary ? JSON.parse(JSON.stringify(summary)).constructor === Object ? JSON.parse(JSON.stringify(summary)) : null : null; } catch (e) { return { error: String(e) }; } })()`); } catch (e) { result.sessionSummary = { error: String(e.message || e) }; log(`result.sessionSummary read failed: ${e.message}`); }
    await tryExportVisionEvidence(true);
    await tryExportDemoEvidence(true);
    if (args.demoEvidence) {
      try {
        const fullRecord = await evaluate(`(() => {
          const r = (typeof latestCompetitionRecord !== "undefined" && latestCompetitionRecord)
            || (typeof competitionSession !== "undefined" && competitionSession?.recorder?.record);
          return r ? JSON.parse(JSON.stringify(r)) : null;
        })()`, false, 120000);
        assert.ok(fullRecord, "complete native record unavailable");
        assert.equal(fullRecord.taskId, MISSION_TASK.guangyang2);
        const recordPath = path.resolve(args.out.replace(/\.json$/, "") + ".record.json");
        const bytes = Buffer.from(JSON.stringify(fullRecord), "utf8");
        await fs.promises.mkdir(path.dirname(recordPath), { recursive: true });
        await fs.promises.writeFile(recordPath, bytes);
        result.fullRecordFile = recordPath;
        result.fullRecordExport = { runId: fullRecord.runId, taskId: fullRecord.taskId, bytes: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
          events: fullRecord.events?.length ?? 0, inputs: fullRecord.inputs?.length ?? 0,
          samples: fullRecord.samples?.length ?? 0, visionFrames: fullRecord.visionFrames?.length ?? 0 };
        try { hostIO.finalNativeVerification = verifyNativeExport(fullRecord, visionArchive, visionPath); }
        catch (error) {
          const message = `final native export verification: ${String(error.message || error)}`;
          hostIO.finalNativeVerification = { allPass: false, error: message };
          visionArchive.exportErrors.push({ at: new Date().toISOString(), message });
          result.visionExportErrors = visionArchive.exportErrors;
          await writeManifest(visionPath, visionArchive, "vision");
        }
        const seenDemoEvents = new Set();
        const expected = (fullRecord.events || []).filter(event => {
          if (event.objectRole !== "target" || !((event.type === "package_grabbed" && event.accepted === true)
            || event.type === "package_delivered")) return false;
          const key = `${event.packageId}:${event.type}`;
          if (seenDemoEvents.has(key)) return false;
          seenDemoEvents.add(key);
          return true;
        });
        result.demoEvidence = { file: result.demoEvidenceFile ?? null, frames: demoArchive.frames.length,
          requiredEventScope: "first successful grab and first delivery for each target package; at most four PNGs",
          expectedEvents: expected.length, allSuccessEventsHaveScreenshots: expected.every(event =>
            demoArchive.frames.some(frame => frame.runId === fullRecord.runId && frame.eventSeq === event.seq
              && frame.eventType === event.type && frame.packageId === event.packageId)),
          nativeFrameBytes: demoArchive.nativeFrameBytes, screenshotBytes: demoArchive.screenshotBytes,
          combinedImageBytes: demoArchive.combinedImageBytes, budgetBytes: demoArchive.evidenceBudgetBytes,
          budgetEnforcedOn: "native_vision_only",
          combinedImagesWithinBudget: demoArchive.combinedImagesWithinBudget,
          allScreenshotBytesExported: demoArchive.allScreenshotBytesExported,
          hookErrors: demoArchive.hookErrors || [], exportErrors: demoArchive.exportErrors };
      } catch (error) {
        result.fullRecordExport = { error: String(error.message || error) };
        result.demoEvidence = { error: "full record export/validation failed", exportErrors: demoArchive.exportErrors };
        log(`demo full record export failed: ${error.message || error}`);
      }
    }
    result.visionExport = { frames: visionArchive.frames.length,
      observeQueries: visionArchive.queries.filter(q => q.method === "observe").length,
      nativeFrames: visionArchive.nativeFrameCount ?? null, nativeBytes: visionArchive.nativeFrameBytes ?? null,
      budgetBytes: visionArchive.evidenceBudgetBytes, errors: visionArchive.exportErrors,
      validation: visionArchive.validation ?? null,
      finalRecordCountMatches: result.record?.vision?.frameCount === visionArchive.nativeFrameCount,
      finalRecordBytesMatch: result.record?.vision?.frameBytes === visionArchive.nativeFrameBytes };
    result.finishedAt = new Date().toISOString();
    result.hostIO = { ...hostIO, cdp: client.metrics,
      metricScope: "CDP JSON request/response UTF-8 payload bytes (not websocket headers); terminal and manifest file writes; PNG/full-record writes excluded from write totals" };
    await fs.promises.mkdir(path.dirname(args.out), { recursive: true });
    await fs.promises.writeFile(args.out, JSON.stringify(result, null, 1), "utf8");
    console.log(JSON.stringify({ out: args.out, runState: result.runState, lines: result.lines.length, score: result.score.total, wallSeconds: result.wallSeconds }));
  } finally {
    try { client?.close(); } catch (_e) {}
    try { browserProcess?.kill("SIGTERM"); } catch (_e) {}
    try { server.closeAllConnections?.(); } catch (_e) {}
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }
}

module.exports = { terminalDelta, persistTerminalDelta, verifyNativeExport, visionManifestSignature, demoManifestSignature };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 200));
