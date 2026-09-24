#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter, once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { createServer } = require("../server.js");
const { GUANGYANG_ISLAND_CONFIG } = require("../competition-core.js");
const { defaultLayout } = require("../backend/guangyang-map-config-store.js");
const { assignedVariantId } = require("../backend/guangyang-map-pool.js");
const { runRoute: runGuangyangSafeRoute } = require("./validate-guangyang-safe-route.js");
const { runRecoveryRoute: runGuangyangRecoveryRoute } = require("./validate-guangyang-recovery-route.js");

const fsPromises = fs.promises;
const E2E_PREFIX = "chenlong-browser-e2e-";
const DEFAULT_TIMEOUT_MS = 20_000;
const PYTHON_TIMEOUT_MS = 120_000;
const PAGE_WIDTH = 1844;
const PAGE_HEIGHT = 1216;
const FULL_GUANGYANG_MODE = process.argv.includes("--guangyang");
const GUANGYANG_RECOVERY_MODE = process.argv.includes("--guangyang-recovery");
const TOPOLOGY_PLANNER_MODE = process.argv.includes("--topology-planner");
const BATCH_SMOKE_MODE = process.argv.includes("--batch-smoke");
const RANKED_SMOKE_MODE = process.argv.includes("--ranked-smoke");
const GUANGYANG_LONG_MODE = FULL_GUANGYANG_MODE || GUANGYANG_RECOVERY_MODE || TOPOLOGY_PLANNER_MODE;
const BATCH_SMOKE_TIMEOUT_MS = 240_000;
const RANKED_SMOKE_TIMEOUT_MS = 300_000;
const BATCH_SMOKE_SOURCE = [
  "# browser-e2e five-slot source lock sentinel",
  'print("browser-e2e-batch", robot.odometry()["distanceCm"])'
].join("\n");
const BATCH_DISCOVERY_LOST_SOURCE = 'print("browser-e2e-lost-batch")';
const RANKED_COMPETITION_ID = "2026-r2-gyi-local-screening.1";
const RANKED_EVALUATION_PATH = `/api/v1/competitions/${RANKED_COMPETITION_ID}/ranked-evaluation`;
const ADMIN_RANKED_RANKING_PATH = `/api/v1/admin/competitions/${RANKED_COMPETITION_ID}`
  + "/ranked-evaluation/ranking";
const RANKED_SMOKE_SOURCE = [
  "# browser-e2e ranked five-slot source lock sentinel",
  'print("browser-e2e-ranked", robot.odometry()["distanceCm"])'
].join("\n");
const RANKED_SMOKE_TEAM_ID = "ranked-e2e-team";
const RANKED_CONFLICT_SOURCE = 'print("browser-e2e-ranked-conflict")';
const RANKED_CONFLICT_TEAM_ID = "ranked-e2e-conflict-team";
const RANKED_RECOVERY_SOURCE = 'print("browser-e2e-ranked-open-recovery")';
const RANKED_RECOVERY_TEAM_ID = "ranked-e2e-recovery-team";
const GUANGYANG_MAP_PATHNAME = "/word/广阳岛仿真沙盘地图.png";

if ([FULL_GUANGYANG_MODE, GUANGYANG_RECOVERY_MODE, TOPOLOGY_PLANNER_MODE, BATCH_SMOKE_MODE, RANKED_SMOKE_MODE]
  .filter(Boolean).length > 1) {
  throw new Error("--guangyang、--guangyang-recovery、--topology-planner、--batch-smoke 与 --ranked-smoke 不能同时使用。");
}

function configuredDeviceScaleFactor() {
  const value = Number(process.env.CHENLONG_E2E_DEVICE_SCALE_FACTOR || 1);
  if (!Number.isFinite(value) || value < 1 || value > 2) {
    throw new Error("CHENLONG_E2E_DEVICE_SCALE_FACTOR 必须是 1 到 2 之间的数字。");
  }
  return value;
}

function log(message) {
  process.stdout.write(`[browser-e2e] ${message}\n`);
}

function requiredNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 4) || typeof globalThis.WebSocket !== "function") {
    throw new Error(
      `真实浏览器 E2E 需要 Node.js 22.4 或更高版本（当前 ${process.versions.node}），` +
      "应用本身仍可使用 package.json 声明的 Node.js 18。"
    );
  }
}

function executableWorks(command) {
  try {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true
    });
    return result.status === 0;
  } catch (_error) {
    return false;
  }
}

function browserCandidates() {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";
    return [
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      localAppData && path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      path.join(os.homedir(), "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge")
    ];
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
}

function resolveBrowserExecutable() {
  const override = String(process.env.CHENLONG_BROWSER_PATH || "").trim().replace(/^"|"$/g, "");
  if (override) {
    if ((path.isAbsolute(override) && fs.existsSync(override)) || executableWorks(override)) return override;
    throw new Error(`CHENLONG_BROWSER_PATH 指向的浏览器不可执行：${override}`);
  }
  for (const candidate of browserCandidates()) {
    if (path.isAbsolute(candidate) ? fs.existsSync(candidate) : executableWorks(candidate)) return candidate;
  }
  throw new Error(
    "没有找到 Chrome 或 Edge。请安装任一浏览器，或通过 CHENLONG_BROWSER_PATH 指定可执行文件。"
  );
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitUntil(probe, description, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError ? `；最后错误：${lastError.message || lastError}` : "";
  throw new Error(`等待${description}超时（${timeoutMs}ms）${suffix}`);
}

function boundedTail(value, maximum = 64 * 1024) {
  const source = String(value || "");
  return source.length <= maximum ? source : source.slice(-maximum);
}

class CdpConnection extends EventEmitter {
  constructor(webSocketUrl) {
    super();
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextCommandId = 0;
    this.pending = new Map();
    this.closed = false;
  }

  async connect(timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.socket) return;
    const socket = new WebSocket(this.webSocketUrl);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 Chrome DevTools Protocol 超时")), timeoutMs);
      const finish = callback => event => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        callback(event);
      };
      const onOpen = finish(() => resolve());
      const onError = finish(event => reject(new Error(event?.message || "无法连接 Chrome DevTools Protocol")));
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    socket.addEventListener("message", event => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", event => {
      this.emit("transportError", new Error(event?.message || "Chrome DevTools Protocol 连接错误"));
    });
  }

  async handleMessage(data) {
    let source;
    if (typeof data === "string") source = data;
    else if (data instanceof ArrayBuffer) source = Buffer.from(data).toString("utf8");
    else if (ArrayBuffer.isView(data)) source = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    else if (data && typeof data.arrayBuffer === "function") source = Buffer.from(await data.arrayBuffer()).toString("utf8");
    else source = String(data);

    let message;
    try {
      message = JSON.parse(source);
    } catch (_error) {
      this.emit("transportError", new Error("Chrome DevTools Protocol 返回了无效 JSON"));
      return;
    }
    if (Number.isSafeInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(`${pending.method} 失败：${message.error.message || "未知 CDP 错误"}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (typeof message.method === "string") {
      this.emit(message.method, {
        method: message.method,
        params: message.params || {},
        sessionId: message.sessionId || null
      });
    }
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Chrome DevTools Protocol 连接已关闭");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("transportClosed");
  }

  send(method, params = {}, sessionId = null, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`无法执行 ${method}：Chrome DevTools Protocol 尚未连接`));
    }
    const id = ++this.nextCommandId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitForEvent(method, predicate = () => true, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const onEvent = event => {
        let accepted = false;
        try {
          accepted = predicate(event.params, event.sessionId, event);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (!accepted) return;
        cleanup();
        resolve(event.params);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待 CDP 事件 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener(method, onEvent);
      };
      this.on(method, onEvent);
    });
  }
}

class BrowserPage {
  constructor(connection, sessionId, origin, diagnostics) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.origin = origin;
    this.diagnostics = diagnostics;
  }

  send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this.connection.send(method, params, this.sessionId, timeoutMs);
  }

  async evaluate(expression, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      const description = detail.exception?.description || detail.text || "页面脚本执行失败";
      throw new Error(description);
    }
    return result.result?.value;
  }

  async waitForValue(expression, description, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = 50,
    accept = value => Boolean(value)
  } = {}) {
    return waitUntil(async () => {
      const value = await this.evaluate(expression);
      return accept(value) ? value : null;
    }, description, timeoutMs, intervalMs);
  }

  async navigate(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.send("Page.navigate", { url }, timeoutMs);
    await this.waitForValue(
      `document.readyState === "complete" ? location.href : ""`,
      `页面加载完成：${url}`,
      { timeoutMs, accept: value => typeof value === "string" && value.length > 0 }
    );
  }

  async reload(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const marker = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await this.evaluate(`document.documentElement.dataset.browserE2eReloadMarker = ${JSON.stringify(marker)}`);
    await this.send("Page.reload", { ignoreCache: true }, timeoutMs);
    await this.waitForValue(
      `document.readyState === "complete"
        && document.documentElement.dataset.browserE2eReloadMarker !== ${JSON.stringify(marker)}
        ? location.href
        : ""`,
      "工作台刷新完成",
      { timeoutMs, accept: value => typeof value === "string" && value.length > 0 }
    );
  }

  async currentUrl() {
    return this.evaluate("location.href");
  }

  async elementState(selector) {
    const encoded = JSON.stringify(selector);
    return this.evaluate(`(() => {
      const element = document.querySelector(${encoded});
      if (!element) return { found: false };
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      return {
        found: true,
        disabled: Boolean(element.disabled || element.matches(":disabled")),
        hidden: Boolean(element.hidden || style.display === "none" || style.visibility === "hidden"),
        width: rect.width,
        height: rect.height,
        x,
        y,
        topMatches: Boolean(top && (top === element || element.contains(top))),
        topTag: top?.tagName || null,
        topId: top?.id || null,
        topClass: top?.className || null
      };
    })()`);
  }

  async click(selector) {
    const state = await this.elementState(selector);
    assert.equal(state?.found, true, `找不到可点击元素 ${selector}`);
    assert.equal(state.hidden, false, `${selector} 当前不可见`);
    assert.equal(state.disabled, false, `${selector} 当前被禁用`);
    assert.ok(state.width > 0 && state.height > 0, `${selector} 没有可点击尺寸`);
    assert.equal(
      state.topMatches,
      true,
      `${selector} 被其他元素遮挡（命中 ${state.topTag || "unknown"}#${state.topId || ""}.${state.topClass || ""}）`
    );
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: state.x,
      y: state.y
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: state.x,
      y: state.y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: state.x,
      y: state.y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  }

  async fill(selector, value) {
    await this.click(selector);
    const modifier = process.platform === "darwin" ? 4 : 2;
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: modifier,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: modifier,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    });
    await this.send("Input.insertText", { text: String(value) });
    const encoded = JSON.stringify(selector);
    const actual = await this.evaluate(`document.querySelector(${encoded})?.value`);
    assert.equal(actual, String(value), `${selector} 输入内容未生效`);
  }

  async select(selector, value) {
    const state = await this.elementState(selector);
    assert.equal(state?.found, true, `找不到下拉框 ${selector}`);
    assert.equal(state.hidden, false, `${selector} 当前不可见`);
    assert.equal(state.disabled, false, `${selector} 当前被禁用`);
    const encodedSelector = JSON.stringify(selector);
    const encodedValue = JSON.stringify(String(value));
    const actual = await this.evaluate(`(() => {
      const select = document.querySelector(${encodedSelector});
      if (!(select instanceof HTMLSelectElement)) return null;
      select.value = ${encodedValue};
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return select.value;
    })()`);
    assert.equal(actual, String(value), `${selector} 没有选中 ${value}`);
  }

  async screenshot(targetPath) {
    const result = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true
    }, 30_000);
    assert.equal(typeof result.data, "string", "浏览器没有返回截图数据");
    await fsPromises.writeFile(targetPath, Buffer.from(result.data, "base64"));
  }
}

function batchFetchProbeBootstrapSource() {
  return `(() => {
    if (globalThis.__chenlongBatchFetchProbe?.schemaVersion === "chenlong.browser-batch-fetch-probe/v1") return;
    const originalFetch = globalThis.fetch.bind(globalThis);
    const probe = {
      schemaVersion: "chenlong.browser-batch-fetch-probe/v1",
      nextId: 0,
      events: []
    };
    const snapshot = () => {
      const editor = document.querySelector("#pythonEditor");
      const panel = document.querySelector("#competitionBatchPanel");
      const verifier = document.querySelector(".competition-verifier");
      const recordActions = document.querySelector(".competition-record-actions");
      const runButton = document.querySelector("#runButton");
      const startButton = document.querySelector("#startCompetitionBatchButton");
      return {
        editorSource: editor?.value || "",
        editorReadOnly: Boolean(editor?.readOnly),
        editorAriaReadOnly: editor?.getAttribute("aria-readonly") || "",
        panelState: panel?.dataset?.state || "",
        currentSlotText: document.querySelector("#competitionBatchSlot")?.textContent?.trim() || "",
        sourceStateText: document.querySelector("#competitionBatchSourceState")?.textContent?.trim() || "",
        runDisabled: Boolean(runButton?.disabled),
        startHidden: Boolean(startButton?.hidden),
        verifierDisplay: verifier ? getComputedStyle(verifier).display : "missing",
        recordActionsDisplay: recordActions ? getComputedStyle(recordActions).display : "missing"
      };
    };
    globalThis.fetch = async (input, init) => {
      let parsedUrl = null;
      try {
        const rawUrl = input instanceof Request ? input.url : String(input);
        parsedUrl = new URL(rawUrl, location.href);
      } catch (_error) {}
      if (!parsedUrl || parsedUrl.origin !== location.origin
        || !parsedUrl.pathname.startsWith("/api/v1/evaluation-batches")) {
        return originalFetch(input, init);
      }
      const id = ++probe.nextId;
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const rawRequestBody = typeof init?.body === "string" ? init.body : null;
      probe.events.push({
        id,
        phase: "request",
        method,
        path: parsedUrl.pathname + parsedUrl.search,
        requestBody: rawRequestBody !== null && rawRequestBody.length <= 16384 ? rawRequestBody : null,
        requestBodyLength: rawRequestBody === null ? null : rawRequestBody.length,
        at: performance.now(),
        snapshot: snapshot()
      });
      let response;
      try {
        response = await originalFetch(input, init);
      } catch (error) {
        probe.events.push({
          id,
          phase: "error",
          method,
          path: parsedUrl.pathname + parsedUrl.search,
          message: String(error?.message || error),
          at: performance.now(),
          snapshot: snapshot()
        });
        throw error;
      }
      let responseBody = null;
      let responseBodyLength = null;
      let responseBodyError = "";
      try {
        const text = await response.clone().text();
        responseBodyLength = text.length;
        if (text.length <= 1048576) responseBody = text;
      } catch (error) {
        responseBodyError = String(error?.message || error);
      }
      probe.events.push({
        id,
        phase: "response",
        method,
        path: parsedUrl.pathname + parsedUrl.search,
        status: response.status,
        responseBody,
        responseBodyLength,
        responseBodyError,
        at: performance.now(),
        snapshot: snapshot()
      });
      return response;
    };
    globalThis.__chenlongBatchFetchProbe = probe;
  })()`;
}

async function installBatchFetchProbe(page) {
  const source = batchFetchProbeBootstrapSource();
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source });
  await page.evaluate(source);
  const schemaVersion = await page.evaluate("globalThis.__chenlongBatchFetchProbe?.schemaVersion || ''");
  assert.equal(schemaVersion, "chenlong.browser-batch-fetch-probe/v1", "五局网络探针没有安装成功");
}

async function resetBatchFetchProbe(page) {
  const reset = await page.evaluate(`(() => {
    const probe = globalThis.__chenlongBatchFetchProbe;
    if (probe?.schemaVersion !== "chenlong.browser-batch-fetch-probe/v1") return false;
    probe.events.length = 0;
    probe.nextId = 0;
    return true;
  })()`);
  assert.equal(reset, true, "五局网络探针无法重置");
}

async function readBatchFetchProbe(page) {
  const probe = await page.evaluate(`(() => {
    const value = globalThis.__chenlongBatchFetchProbe;
    return value ? {
      schemaVersion: value.schemaVersion,
      events: value.events.map(event => structuredClone(event))
    } : null;
  })()`);
  assert.equal(probe?.schemaVersion, "chenlong.browser-batch-fetch-probe/v1", "五局网络探针数据不存在");
  assert.ok(Array.isArray(probe.events), "五局网络探针事件不是数组");
  return probe.events;
}

function rankedFetchProbeBootstrapSource() {
  const rankedPath = JSON.stringify(RANKED_EVALUATION_PATH);
  const adminRankingPath = JSON.stringify(ADMIN_RANKED_RANKING_PATH);
  return `(() => {
    if (globalThis.__chenlongRankedFetchProbe?.schemaVersion === "chenlong.browser-ranked-fetch-probe/v1") return;
    const originalFetch = globalThis.fetch.bind(globalThis);
    const rankedPath = ${rankedPath};
    const adminRankingPath = ${adminRankingPath};
    const probe = {
      schemaVersion: "chenlong.browser-ranked-fetch-probe/v1",
      nextId: 0,
      events: []
    };
    const snapshot = () => {
      const editor = document.querySelector("#pythonEditor");
      const panel = document.querySelector("#rankedEvaluationPanel");
      const verifier = document.querySelector(".competition-verifier");
      const recordActions = document.querySelector(".competition-record-actions");
      const active = typeof activeRankedEvaluation === "undefined" ? null : activeRankedEvaluation;
      return {
        editorSource: editor?.value || "",
        editorReadOnly: Boolean(editor?.readOnly),
        editorAriaReadOnly: editor?.getAttribute("aria-readonly") || "",
        teamInput: document.querySelector("#competitionTeamId")?.value || "",
        teamDisabled: Boolean(document.querySelector("#competitionTeamId")?.disabled),
        panelState: panel?.dataset?.state || "",
        statusText: document.querySelector("#rankedEvaluationStatus")?.textContent?.trim() || "",
        deadlineText: document.querySelector("#rankedEvaluationDeadline")?.textContent?.trim() || "",
        progressText: document.querySelector("#rankedEvaluationProgress")?.textContent?.trim() || "",
        scoreText: document.querySelector("#rankedEvaluationScore")?.textContent?.trim() || "",
        sourceStateText: document.querySelector("#competitionBatchSourceState")?.textContent?.trim() || "",
        runDisabled: Boolean(document.querySelector("#runButton")?.disabled),
        startHidden: Boolean(document.querySelector("#startRankedEvaluationButton")?.hidden),
        verifierDisplay: verifier ? getComputedStyle(verifier).display : "missing",
        recordActionsDisplay: recordActions ? getComputedStyle(recordActions).display : "missing",
        activeSource: active?.source || null,
        activeTeamId: active?.teamId || null,
        activeBatchId: active?.batch?.batchId || null,
        activePhase: active?.batch?.phase || null,
        activeNextSlotIndex: active?.batch?.nextSlotIndex ?? null,
        activeExpiresAt: active?.expiresAt || null,
        activeLeaseSlotIndex: active?.lease?.slotIndex ?? null,
        activeLeaseSessionId: active?.lease?.session?.sessionId || null,
        running: typeof running === "undefined" ? false : Boolean(running),
        operationActive: typeof rankedEvaluationOperation === "undefined"
          ? false
          : Boolean(rankedEvaluationOperation),
        latestRunId: typeof latestCompetitionRecord === "undefined"
          ? null
          : latestCompetitionRecord?.runId || null,
        ordinarySubmissionReceipt: typeof latestCompetitionSubmissionReceipt === "undefined"
          ? false
          : Boolean(latestCompetitionSubmissionReceipt)
      };
    };
    globalThis.fetch = async (input, init) => {
      let parsedUrl = null;
      try {
        const rawUrl = input instanceof Request ? input.url : String(input);
        parsedUrl = new URL(rawUrl, location.href);
      } catch (_error) {}
      if (!parsedUrl || parsedUrl.origin !== location.origin
        || !(parsedUrl.pathname === rankedPath
          || parsedUrl.pathname.startsWith(rankedPath + "/")
          || parsedUrl.pathname === adminRankingPath)) {
        return originalFetch(input, init);
      }
      const id = ++probe.nextId;
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const rawRequestBody = typeof init?.body === "string" ? init.body : null;
      let recordIdentity = null;
      if (/\\/slots\\/[1-5]\\/sessions\\/ses_[a-f0-9]{32}\\/submissions$/.test(parsedUrl.pathname)
        && rawRequestBody !== null) {
        try {
          const record = JSON.parse(rawRequestBody);
          recordIdentity = {
            schemaVersion: record?.schemaVersion || null,
            runId: record?.runId || null,
            serverSessionId: record?.serverSessionId || null,
            challengeDigest: record?.challengeDigest || null,
            teamId: record?.teamId || null,
            sourceCode: record?.sourceCode || null
          };
        } catch (_error) {}
      }
      probe.events.push({
        id,
        phase: "request",
        method,
        path: parsedUrl.pathname + parsedUrl.search,
        requestBody: rawRequestBody !== null && rawRequestBody.length <= 16384 ? rawRequestBody : null,
        requestBodyLength: rawRequestBody === null ? null : rawRequestBody.length,
        recordIdentity,
        at: performance.now(),
        snapshot: snapshot()
      });
      let response;
      try {
        response = await originalFetch(input, init);
      } catch (error) {
        probe.events.push({
          id,
          phase: "error",
          method,
          path: parsedUrl.pathname + parsedUrl.search,
          message: String(error?.message || error),
          at: performance.now(),
          snapshot: snapshot()
        });
        throw error;
      }
      let responseBody = null;
      let responseBodyLength = null;
      let responseBodyError = "";
      try {
        const value = await response.clone().text();
        responseBodyLength = value.length;
        if (value.length <= 2097152) responseBody = value;
      } catch (error) {
        responseBodyError = String(error?.message || error);
      }
      probe.events.push({
        id,
        phase: "response",
        method,
        path: parsedUrl.pathname + parsedUrl.search,
        status: response.status,
        responseBody,
        responseBodyLength,
        responseBodyError,
        at: performance.now(),
        snapshot: snapshot()
      });
      return response;
    };
    globalThis.__chenlongRankedFetchProbe = probe;
  })()`;
}

async function installRankedFetchProbe(page) {
  const source = rankedFetchProbeBootstrapSource();
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source });
  await page.evaluate(source);
  const schemaVersion = await page.evaluate("globalThis.__chenlongRankedFetchProbe?.schemaVersion || ''");
  assert.equal(schemaVersion, "chenlong.browser-ranked-fetch-probe/v1", "筛选五局网络探针没有安装成功");
}

async function resetRankedFetchProbe(page) {
  const reset = await page.evaluate(`(() => {
    const probe = globalThis.__chenlongRankedFetchProbe;
    if (probe?.schemaVersion !== "chenlong.browser-ranked-fetch-probe/v1") return false;
    probe.events.length = 0;
    probe.nextId = 0;
    return true;
  })()`);
  assert.equal(reset, true, "筛选五局网络探针无法重置");
}

async function readRankedFetchProbe(page) {
  const probe = await page.evaluate(`(() => {
    const value = globalThis.__chenlongRankedFetchProbe;
    return value ? {
      schemaVersion: value.schemaVersion,
      events: value.events.map(event => structuredClone(event))
    } : null;
  })()`);
  assert.equal(probe?.schemaVersion, "chenlong.browser-ranked-fetch-probe/v1", "筛选五局网络探针数据不存在");
  assert.ok(Array.isArray(probe.events), "筛选五局网络探针事件不是数组");
  return probe.events;
}

async function startServer(dataDir) {
  const server = createServer({ dataDir });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "测试后端未返回监听地址");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

async function startBrowser(executable, profileDir, stderrState, deviceScaleFactor) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    `--window-size=${PAGE_WIDTH},${PAGE_HEIGHT}`,
    `--force-device-scale-factor=${deviceScaleFactor}`,
    "--enable-automation",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-proxy-server",
    "--disable-features=MediaRouter",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "about:blank"
  ];
  const browserProcess = spawn(executable, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    shell: false
  });
  browserProcess.stderr.setEncoding("utf8");
  browserProcess.stderr.on("data", chunk => {
    stderrState.value = boundedTail(`${stderrState.value}${chunk}`);
  });
  browserProcess.once("error", error => {
    stderrState.value = boundedTail(`${stderrState.value}\n${error.stack || error}`);
  });

  const activePortPath = path.join(profileDir, "DevToolsActivePort");
  const activePort = await waitUntil(async () => {
    if (browserProcess.exitCode !== null) {
      throw new Error(`浏览器提前退出（code=${browserProcess.exitCode}）：${stderrState.value}`);
    }
    try {
      const lines = (await fsPromises.readFile(activePortPath, "utf8"))
        .trim()
        .split(/\r?\n/);
      const port = Number(lines[0]);
      if (!Number.isSafeInteger(port) || port <= 0 || !lines[1]) return null;
      return { port, browserPath: lines[1] };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }, "浏览器调试端口", 20_000, 50);
  const webSocketUrl = activePort.browserPath.startsWith("ws://")
    ? activePort.browserPath
    : `ws://127.0.0.1:${activePort.port}${activePort.browserPath}`;
  return { browserProcess, webSocketUrl };
}

async function stopBrowser(browserProcess, connection) {
  if (connection && !connection.closed) {
    try {
      await connection.send("Browser.close", {}, null, 3_000);
    } catch (_error) {
      // Browser.close commonly closes the transport before returning a reply.
    }
  }
  if (!browserProcess || browserProcess.exitCode !== null) return;
  const exited = once(browserProcess, "exit").then(() => true);
  const graceful = await Promise.race([exited, delay(5_000).then(() => false)]);
  if (!graceful && browserProcess.exitCode === null) {
    browserProcess.kill();
    await Promise.race([once(browserProcess, "exit"), delay(3_000)]);
  }
}

function installDiagnostics(connection, sessionId, origin, diagnostics) {
  const pageEvent = listener => event => {
    if (event.sessionId === sessionId) listener(event.params);
  };
  connection.on("Runtime.exceptionThrown", pageEvent(params => {
    diagnostics.exceptions.push({
      text: params.exceptionDetails?.text || "Uncaught exception",
      description: params.exceptionDetails?.exception?.description || null,
      url: params.exceptionDetails?.url || null,
      lineNumber: params.exceptionDetails?.lineNumber ?? null,
      columnNumber: params.exceptionDetails?.columnNumber ?? null
    });
  }));
  connection.on("Runtime.consoleAPICalled", pageEvent(params => {
    const entry = {
      type: params.type,
      values: (params.args || []).map(value => value.value ?? value.description ?? value.type).slice(0, 10)
    };
    diagnostics.console.push(entry);
  }));
  connection.on("Log.entryAdded", pageEvent(params => {
    diagnostics.logs.push(params.entry || params);
  }));
  connection.on("Network.requestWillBeSent", pageEvent(params => {
    diagnostics.requests.push({
      url: params.request?.url || "",
      method: params.request?.method || "",
      type: params.type || ""
    });
  }));
  connection.on("Network.responseReceived", pageEvent(params => {
    const response = params.response || {};
    if (Number(response.status) >= 400) {
      diagnostics.httpErrors.push({ url: response.url, status: response.status, statusText: response.statusText });
    }
  }));
  connection.on("Network.loadingFailed", pageEvent(params => {
    diagnostics.networkFailures.push({
      requestId: params.requestId,
      errorText: params.errorText,
      canceled: Boolean(params.canceled),
      type: params.type
    });
  }));
  connection.on("Inspector.targetCrashed", pageEvent(params => {
    diagnostics.crashes.push(params);
  }));
  connection.on("Page.javascriptDialogOpening", pageEvent(params => {
    diagnostics.dialogs.push(params);
  }));
  connection.on("transportError", error => {
    diagnostics.transportErrors.push(error.message || String(error));
  });
  diagnostics.origin = origin;
}

async function createPage(connection, origin, downloadsDir, diagnostics) {
  await connection.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadsDir,
    eventsEnabled: true
  });
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  assert.ok(sessionId, "无法附加到浏览器页面目标");
  installDiagnostics(connection, sessionId, origin, diagnostics);
  await Promise.all([
    connection.send("Page.enable", {}, sessionId),
    connection.send("Runtime.enable", {}, sessionId),
    connection.send("Log.enable", {}, sessionId),
    connection.send("Network.enable", {}, sessionId),
    connection.send("Inspector.enable", {}, sessionId)
  ]);
  return new BrowserPage(connection, sessionId, origin, diagnostics);
}

function runStateExpression() {
  return `(() => {
    const state = document.querySelector("#competitionRunState")?.textContent?.trim() || "";
    const action = document.querySelector("#competitionRecordActionStatus");
    return {
      state,
      action: action?.dataset?.action || "",
      actionStatus: action?.dataset?.status || "",
      actionText: action?.textContent?.trim() || "",
      submissionText: document.querySelector("#competitionSubmissionResult")?.textContent?.trim() || "",
      submissionStatus: document.querySelector("#competitionSubmissionResult")?.dataset?.status || ""
    };
  })()`;
}

async function waitForPython(page) {
  const state = await page.waitForValue(`(() => {
    const button = document.querySelector("#runButton");
    const overlay = document.querySelector("#loadingOverlay");
    const error = overlay?.querySelector(".loading-error")?.textContent?.trim() || "";
    if (error) return { done: true, error };
    if (button && !button.disabled && (!overlay || overlay.classList.contains("is-hidden"))) {
      const canvas = document.querySelector("#simCanvas");
      return {
        done: true,
        ready: true,
        canvasWidth: canvas?.width || 0,
        canvasHeight: canvas?.height || 0,
        hudVisible: Boolean(document.querySelector("#competitionHud") && !document.querySelector("#competitionHud").hidden)
      };
    }
    return null;
  })()`, "本地 Python 与仿真界面准备完成", {
    timeoutMs: PYTHON_TIMEOUT_MS,
    intervalMs: 100,
    accept: value => Boolean(value?.done)
  });
  if (state.error) throw new Error(`Python 环境加载失败：${state.error}`);
  assert.equal(state.ready, true, "Python 环境未就绪");
  assert.ok(state.canvasWidth > 0 && state.canvasHeight > 0, "3D 画布没有有效尺寸");
  assert.equal(state.hudVisible, true, "广阳岛比赛 HUD 未显示");
}

async function testRealCarPlanBeforeDispatch(page, diagnostics) {
  log("实车模式：验证完整规划通过前不会发送移动，并且不创建成绩记录");
  await waitForPython(page);
  const requestStartIndex = diagnostics.requests.length;
  await page.evaluate(`(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const cameraStream = document.querySelector("#cameraStream");
    Object.defineProperty(cameraStream, "src", {
      configurable: true,
      get() { return this.dataset.e2eSrc || ""; },
      set(value) {
        this.dataset.e2eSrc = String(value);
        queueMicrotask(() => this.onload?.(new Event("load")));
      }
    });
    globalThis.__realCarE2e = { originalFetch, requests: [], cameraRequests: [], cameraStream };
    globalThis.fetch = async (input, init) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, location.href);
      if (url.origin === "http://192.168.4.1") {
        if (url.pathname === "/api/control") {
          globalThis.__realCarE2e.requests.push(url.toString());
          return new Response("", { status: 200 });
        }
        if (["/api/camera/open", "/api/camera/close"].includes(url.pathname)) {
          globalThis.__realCarE2e.cameraRequests.push(url.pathname);
          return new Response("", { status: 200 });
        }
      }
      return originalFetch(input, init);
    };
    const target = document.querySelector("#targetSelect");
    target.value = "real";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await page.waitForValue(`document.querySelector("#realCameraStage")?.dataset.cameraState`, "实车摄像头预览连接", {
    timeoutMs: 5_000,
    intervalMs: 20,
    accept: value => value === "live"
  });
  assert.deepEqual(await page.evaluate("globalThis.__realCarE2e.cameraRequests"), ["/api/camera/open"],
    "进入实车模式应打开摄像头预览");
  await page.fill("#pythonEditor", 'robot.forward(25)\nraise ValueError("planned failure")');
  await page.click("#runButton");
  await page.waitForValue(`(() => {
    const rows = [...document.querySelectorAll("#actionLog .log-text")].map(row => row.textContent || "");
    return !running && !realStopPending && rows.some(text => text.includes("Python 代码出错"));
  })()`, "实车非法计划在下发前终止", { timeoutMs: 20_000, intervalMs: 20 });
  const rejectedActions = await page.evaluate(`globalThis.__realCarE2e.requests.map(raw => new URL(raw).searchParams.get("action"))`);
  assert.deepEqual(rejectedActions, ["stop"], "规划失败时只能发送兜底停止，不能先发送移动");

  await page.evaluate("globalThis.__realCarE2e.requests.length = 0");
  await page.fill("#pythonEditor", "robot.forward(1)\nrobot.right_angle(1)");
  await page.click("#runButton");
  await page.waitForValue(`(() => {
    const rows = [...document.querySelectorAll("#actionLog .log-text")].map(row => row.textContent || "");
    return !running && !realStopPending && rows.some(text => text.includes("Python 基础动作已执行完毕"));
  })()`, "合法实车计划顺序执行并停车", { timeoutMs: 20_000, intervalMs: 20 });
  const acceptedActions = await page.evaluate(`globalThis.__realCarE2e.requests.map(raw => new URL(raw).searchParams.get("action"))`);
  assert.deepEqual(acceptedActions, ["up", "right", "stop"], "合法计划应按顺序下发基础动作并在退出时停车");

  const scoreWrites = diagnostics.requests.slice(requestStartIndex).filter(entry => {
    if (entry.method !== "POST") return false;
    const pathname = new URL(entry.url).pathname;
    return pathname === "/api/v1/sessions"
      || /\/api\/v1\/sessions\/[^/]+\/(?:drafts|submissions)$/.test(pathname)
      || /\/api\/v1\/records\/[^/]+\/submit$/.test(pathname);
  });
  assert.deepEqual(scoreWrites, [], "实车模式不得创建场次、草稿、提交或成绩");

  const cameraLifecycle = await page.evaluate(`(async () => {
    const target = document.querySelector("#targetSelect");
    target.value = "sim";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    while (realStopPending) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 0));
    const cameraRequests = [...globalThis.__realCarE2e.cameraRequests];
    const cameraStream = globalThis.__realCarE2e.cameraStream;
    globalThis.fetch = globalThis.__realCarE2e.originalFetch;
    delete cameraStream.dataset.e2eSrc;
    delete cameraStream.src;
    delete globalThis.__realCarE2e;
    return cameraRequests;
  })()`);
  assert.deepEqual(cameraLifecycle, ["/api/camera/open", "/api/camera/close"],
    "切回仿真模式应释放实车摄像头");
}

async function pinAssignedChallengeOneMapToDefault(page, dataDir, credentials) {
  const authState = JSON.parse(await fsPromises.readFile(path.join(dataDir, "auth", "auth-store.json"), "utf8"));
  const user = authState.users.find(item => item.username === credentials.username);
  assert.ok(user?.teamId, "隔离测试账号缺少服务端队伍编号");
  const taskId = GUANGYANG_ISLAND_CONFIG.taskId;
  const variantId = assignedVariantId(taskId, user.teamId);
  if (variantId === "map-01") return variantId;
  const layout = defaultLayout(GUANGYANG_ISLAND_CONFIG);
  const receipt = await page.evaluate(`(async () => {
    const endpoint = ${JSON.stringify(`/api/v1/admin/map-config/${taskId}/${variantId}`)};
    const currentResponse = await fetch(endpoint, { credentials: "same-origin" });
    const current = await currentResponse.json();
    if (!currentResponse.ok) return { ok: false, stage: "get", status: currentResponse.status, current };
    const updateResponse = await fetch(endpoint, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "chenlong.guangyang-map-config-update/v1",
        baseRevision: current.revision,
        layout: ${JSON.stringify(layout)}
      })
    });
    const updated = await updateResponse.json();
    return { ok: updateResponse.ok, stage: "put", status: updateResponse.status, updated };
  })()`);
  assert.equal(receipt.ok, true, `无法把 ${variantId} 固定为内部路线使用的默认地图：${JSON.stringify(receipt)}`);
  assert.equal(receipt.updated?.revision, 1, `${variantId} 的隔离地图修订号不正确`);
  return variantId;
}

async function registerAndEnter(page, origin, credentials, { dataDir, pinDefaultChallengeOne = false } = {}) {
  log("1/8 验证登录门禁并创建隔离测试账号");
  await page.navigate(`${origin}/`);
  const loginUrl = await page.waitForValue(
    `location.pathname === "/login.html" ? location.href : ""`,
    "受保护首页重定向到登录页"
  );
  assert.match(loginUrl, /\/login\.html\?returnTo=%2F/, "首页没有保留登录后的返回地址");
  await page.click("#registerTab");
  await page.waitForValue(
    `document.querySelector("#registerPanel")?.hidden === false`,
    "注册表单显示"
  );
  await page.fill("#registerTeamName", credentials.teamName);
  await page.select("#registerGroup", credentials.group);
  await page.fill("#registerUsername", credentials.username);
  await page.fill("#registerPassword", credentials.password);
  await page.fill("#registerPasswordConfirm", credentials.password);
  await page.click("#registerSubmit");
  const inviteCode = await page.waitForValue(
    `(() => {
      const dialog = document.querySelector("#teamInviteDialog");
      const code = document.querySelector("#teamInviteCodeValue")?.textContent?.trim() || "";
      return dialog?.open && /^[A-Z0-9]{8}$/.test(code) ? code : "";
    })()`,
    "新队伍的邀请码弹窗显示"
  );
  assert.match(inviteCode, /^[A-Z0-9]{8}$/, "新队伍没有生成有效的邀请码");
  await page.click("#teamInviteContinueButton");
  const adminLanding = await page.waitForValue(
    `(() => {
      if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== "/admin.html") return null;
      const isVisible = element => {
        if (!element || element.hidden || element.closest("[hidden], [inert]")) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const name = document.querySelector("#currentUserName")?.textContent?.trim() || "";
      const role = document.querySelector("#currentUserRole")?.textContent?.trim() || "";
      const workspaceLink = [...document.querySelectorAll('.portal-nav a[href="./"]')]
        .find(link => /仿真工作台/.test(link.textContent || ""));
      const controls = [
        document.querySelector("#adminUsernameFilter"),
        document.querySelector("#adminTeamFilter"),
        document.querySelector("#adminScoreSort"),
        document.querySelector("#adminTeamRecordMode"),
        document.querySelector("#refreshAdminRecordsButton")
      ];
      if (!name || name.includes("验证") || !role || !workspaceLink || !controls.every(isVisible)) return null;
      return {
        href: location.href,
        name,
        role,
        title: document.querySelector("#adminTitle")?.textContent?.trim() || "",
        usernameFilterVisible: isVisible(controls[0]),
        teamFilterVisible: isVisible(controls[1]),
        scoreSortVisible: isVisible(controls[2]),
        teamModeVisible: isVisible(controls[3]),
        refreshVisible: isVisible(controls[4]),
        workspaceLinkVisible: isVisible(workspaceLink)
      };
    })()`,
    "首个管理员确认邀请码后进入记录后台",
    { timeoutMs: 30_000 }
  );
  assert.equal(new URL(adminLanding.href).pathname, "/admin.html", "首个管理员没有直接进入后台");
  assert.equal(adminLanding.name, credentials.username, "后台显示的管理员用户名不匹配");
  assert.match(adminLanding.role, /管理员/, "隔离数据目录中的首个账号应为管理员");
  assert.equal(adminLanding.title, "管理后台", "管理员落点不是管理后台");
  assert.equal(adminLanding.usernameFilterVisible, true, "后台用户名筛选控件不可见");
  assert.equal(adminLanding.teamFilterVisible, true, "后台队伍名筛选控件不可见");
  assert.equal(adminLanding.scoreSortVisible, true, "后台分数排序控件不可见");
  assert.equal(adminLanding.teamModeVisible, true, "后台每队最高分模式控件不可见");
  assert.equal(adminLanding.refreshVisible, true, "后台记录刷新控件不可见");
  assert.equal(adminLanding.workspaceLinkVisible, true, "后台缺少可见的仿真工作台导航");

  if (pinDefaultChallengeOne) {
    const variantId = await pinAssignedChallengeOneMapToDefault(page, dataDir, credentials);
    log(`内部固定路线使用隔离 ${variantId}，已与默认任务1地图对齐`);
  }

  await page.click('.portal-nav a[href="./"]');
  await page.waitForValue(
    `location.origin === ${JSON.stringify(origin)} && location.pathname === "/" && Boolean(document.querySelector("#simCanvas"))`,
    "通过后台导航返回仿真工作台",
    { timeoutMs: 30_000 }
  );
  const identity = await page.waitForValue(
    `(() => {
      const name = document.querySelector("#currentUserName")?.textContent?.trim() || "";
      const role = document.querySelector("#currentUserRole")?.textContent?.trim() || "";
      return name && !name.includes("验证") ? { name, role } : null;
    })()`,
    "仿真工作台登录身份显示"
  );
  assert.equal(identity.name, credentials.username, "登录后的管理员用户名不匹配");
  assert.match(identity.role, /管理员/, "返回工作台后管理员身份丢失");
}

function guangyangMapGetRequests(diagnostics, startIndex = 0) {
  return diagnostics.requests.slice(startIndex).filter(entry => {
    if (entry.method !== "GET") return false;
    try {
      return decodeURIComponent(new URL(entry.url).pathname) === GUANGYANG_MAP_PATHNAME;
    } catch (_error) {
      return false;
    }
  });
}

async function runCompetition(page, diagnostics) {
  log("2/8 等待 Pyodide 与三维场景，并运行短 Python 程序");
  await waitForPython(page);
  await assertTrainingVisionWorkbenchHidden(page, "正式广阳岛场景");
  await page.waitForValue(`(() => {
    const flatMap = typeof guangyangFlatMapPlane === "undefined" ? null : guangyangFlatMapPlane;
    const terrain = typeof guangyangTerrainMesh === "undefined" ? null : guangyangTerrainMesh;
    const texture = flatMap?.material?.map;
    const image = texture?.image;
    return flatMap?.parent && terrain?.parent && texture && Number(image?.width) > 0 && Number(image?.height) > 0
      ? { width: Number(image.width), height: Number(image.height) }
      : null;
  })()`, "首次广阳岛地图纹理加载完成", { timeoutMs: 30_000 });
  const mapRequestStartIndex = diagnostics.requests.length;
  const orbitPoint = await page.evaluate(`(() => {
    const canvas = document.querySelector("#simCanvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const candidates = [[0.44, 0.82], [0.62, 0.82], [0.78, 0.72], [0.38, 0.68], [0.72, 0.58]];
    for (const [fx, fy] of candidates) {
      const x = rect.left + rect.width * fx;
      const y = rect.top + rect.height * fy;
      if (document.elementFromPoint(x, y) === canvas) return { x, y, right: rect.right, top: rect.top };
    }
    return null;
  })()`);
  assert.ok(orbitPoint, "3D 画布没有可用于调整视角的可见区域");
  const orbitEnd = {
    x: Math.min(orbitPoint.right - 8, orbitPoint.x + 72),
    y: Math.max(orbitPoint.top + 8, orbitPoint.y - 38)
  };
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: orbitPoint.x, y: orbitPoint.y
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: orbitPoint.x, y: orbitPoint.y, button: "left", buttons: 1, clickCount: 1
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: orbitEnd.x, y: orbitEnd.y, button: "left", buttons: 1
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: orbitEnd.x, y: orbitEnd.y, button: "left", buttons: 0, clickCount: 1
  });
  const cameraBeforeRun = await page.waitForValue(`(() => cameraMode === "free" ? ({
    mode: cameraMode,
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: [orbitTarget.x, orbitTarget.y, orbitTarget.z],
    yaw: orbitYaw,
    pitch: orbitPitch,
    distance: orbitDistance,
    activePresetCount: document.querySelectorAll("[data-view].is-active").length
  }) : null)()`, "手动调整 3D 自由视角");
  assert.equal(cameraBeforeRun.activePresetCount, 0, "手动调整后仍错误选中了预设视角");
  const editorSource = [
    "# browser-e2e editor preservation sentinel",
    "graph = robot.map_graph()",
    "start_pose = robot.odometry()",
    "road = robot.road_state()",
    'print("browser-e2e-navigation-start", len(graph["nodes"]), len(graph["edges"]), start_pose["distanceCm"], road["onRoad"])',
    'print("browser-e2e-vision", robot.observe("目标物"))',
    "follow = robot.follow_road(20, 40)",
    'print("browser-e2e-navigation-control", follow["accepted"], follow["stoppedBy"], follow["distanceCm"])',
    "end_pose = robot.odometry()",
    'print("browser-e2e-navigation-end", end_pose["distanceCm"])',
    'print("browser-e2e-ok")'
  ].join("\n");
  await page.fill("#pythonEditor", editorSource);
  await page.click("#runButton");
  await page.waitForValue(
    runStateExpression(),
    "比赛进入计时运行状态",
    { timeoutMs: 30_000, accept: value => value?.state === "计时运行中" }
  );
  const cameraAfterRunStarted = await page.evaluate(`(() => ({
    mode: cameraMode,
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: [orbitTarget.x, orbitTarget.y, orbitTarget.z],
    yaw: orbitYaw,
    pitch: orbitPitch,
    distance: orbitDistance,
    activePresetCount: document.querySelectorAll("[data-view].is-active").length
  }))()`);
  assert.equal(cameraAfterRunStarted.mode, "free", "点击运行后 3D 视角被切回预设模式");
  assert.equal(cameraAfterRunStarted.activePresetCount, 0, "点击运行后错误激活了预设视角按钮");
  for (const key of ["yaw", "pitch", "distance"]) {
    assert.ok(Math.abs(cameraAfterRunStarted[key] - cameraBeforeRun[key]) < 1e-9,
      `点击运行后镜头 ${key} 被重置`);
  }
  for (const key of ["position", "target"]) {
    assert.ok(cameraAfterRunStarted[key].every((value, index) => (
      Math.abs(value - cameraBeforeRun[key][index]) < 1e-9
    )), `点击运行后镜头 ${key} 被重置`);
  }
  const finished = await page.waitForValue(
    runStateExpression(),
    "短程序运行结束",
    {
      timeoutMs: 30_000,
      accept: value => value?.state === "运行已结束" || value?.state === "任务完成"
    }
  );
  assert.match(finished.state, /运行已结束|任务完成/);
  await delay(100);
  const repeatedMapRequests = guangyangMapGetRequests(diagnostics, mapRequestStartIndex);
  assert.equal(repeatedMapRequests.length, 0,
    `首次地图纹理就绪后点击运行又请求了广阳岛地图 PNG：${repeatedMapRequests.map(item => item.url).join(", ")}`);
  const output = await page.evaluate(`document.querySelector("#pythonOutputContent")?.textContent || ""`);
  assert.match(output, /browser-e2e-navigation-start\s+[1-9]\d*\s+[1-9]\d*\s+0(?:\.0+)?\s+True/,
    "Python 标准输出没有出现导航传感器初始状态");
  assert.match(output, /browser-e2e-navigation-control\s+True\s+max_distance\s+20(?:\.0+)?/,
    "Python 标准输出没有出现安全短程道路控制结果");
  assert.match(output, /browser-e2e-navigation-end\s+[1-9]\d*(?:\.\d+)?/,
    "Python 标准输出没有出现移动后的里程计状态");
  assert.match(output, /browser-e2e-ok/, "Python 标准输出没有出现预期内容");
  assert.equal(
    await page.evaluate(`document.querySelector("#pythonEditor")?.value || ""`),
    editorSource,
    "运行结束时编辑器代码被意外改写"
  );
  return editorSource;
}

function walkJsonValue(value, visitor) {
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach(item => walkJsonValue(item, visitor));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([key, item]) => {
    visitor(item, key);
    walkJsonValue(item, visitor);
  });
}

function nestedKeyCount(value, expectedKey) {
  let count = 0;
  walkJsonValue(value, (_item, key) => {
    if (key === expectedKey) count += 1;
  });
  return count;
}

function nestedKeyValues(value, expectedKey) {
  const matches = [];
  walkJsonValue(value, (item, key) => {
    if (key === expectedKey) matches.push(item);
  });
  return matches;
}

function containsExactString(value, expected) {
  let found = false;
  walkJsonValue(value, item => {
    if (typeof item === "string" && item === expected) found = true;
  });
  return found;
}

function parseBatchProbeResponse(event, label) {
  assert.equal(event.phase, "response", `${label}不是响应事件`);
  assert.equal(event.responseBodyError, "", `${label}响应体读取失败：${event.responseBodyError || "未知错误"}`);
  assert.equal(typeof event.responseBody, "string", `${label}响应体超过烟测采集上限`);
  assert.equal(event.responseBodyLength, event.responseBody.length, `${label}响应体长度记录不一致`);
  try {
    return JSON.parse(event.responseBody);
  } catch (error) {
    throw new Error(`${label}没有返回有效 JSON：${error.message || error}`);
  }
}

function pairBatchProbeEvents(events, label) {
  assert.ok(Array.isArray(events), `${label}网络事件不是数组`);
  assert.equal(events.some(event => event.phase === "error"), false, `${label}存在失败的五局 API 请求`);
  assert.equal(events.length % 2, 0, `${label}网络事件没有成对结束`);
  const pairs = [];
  let previousAt = -Infinity;
  for (let index = 0; index < events.length; index += 2) {
    const request = events[index];
    const response = events[index + 1];
    assert.equal(request.phase, "request", `${label}第 ${index + 1} 个事件不是请求`);
    assert.equal(response.phase, "response", `${label}第 ${index + 2} 个事件不是响应`);
    assert.equal(response.id, request.id, `${label}请求与响应编号不一致`);
    assert.equal(response.method, request.method, `${label}请求与响应方法不一致`);
    assert.equal(response.path, request.path, `${label}请求与响应路径不一致`);
    assert.ok(request.at >= previousAt, `${label}请求顺序倒退`);
    assert.ok(response.at >= request.at, `${label}响应早于请求`);
    previousAt = response.at;
    pairs.push({ request, response });
  }
  return pairs;
}

function assertBatchPublicResponsePrivacy(payload, {
  label,
  lockedSource,
  expectLease = false,
  expectOpenList = false
}) {
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload), `${label}不是 JSON 对象`);
  assert.equal(payload.authoritative, false, `${label}没有声明 authoritative: false`);
  assert.equal(containsExactString(payload, lockedSource), false, `${label}泄露了锁定源码正文`);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(
    serialized,
    /gyi-layout-|privateLayoutSelection|"layoutId"|"anchorId"|"anchorIds"|"seedDigest"|"sourcePosition"|"privateValue"|"futureLayouts"|"runDefinitions"|"layouts"/,
    `${label}泄露了私有布局目录或未来定义`
  );
  const definitionCount = nestedKeyCount(payload, "interactionDefinition");
  const runDefinitionCount = nestedKeyCount(payload, "runDefinition");
  if (expectLease) {
    assert.equal(definitionCount, 1, `${label}必须且只能返回当前一局交互定义`);
    assert.equal(runDefinitionCount, 1, `${label}必须且只能返回当前一局运行定义`);
    assert.equal(payload.lease?.runDefinition?.interactionDefinition?.packages?.length, 3,
      `${label}当前局没有且仅有三类物体`);
    const commitments = nestedKeyValues(payload, "layoutCommitment")
      .filter(value => typeof value === "string");
    assert.ok(commitments.length >= 1, `${label}缺少当前局布局承诺`);
    assert.equal(new Set(commitments).size, 1, `${label}一次响应出现了多局布局承诺`);
  } else {
    assert.equal(definitionCount, 0, `${label}不应下发任何布局交互定义`);
    assert.equal(runDefinitionCount, 0, `${label}不应下发任何运行定义`);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "lease"), false, `${label}意外包含场次租约`);
  }
  if (expectOpenList) {
    assert.equal(payload.schemaVersion, "chenlong.open-batch-list/v1", `${label}列表版本不匹配`);
    assert.equal(payload.phase, "open", `${label}不是 open 批次列表`);
    assert.ok(Array.isArray(payload.batches), `${label}没有公开批次数组`);
    assert.equal(nestedKeyCount(payload, "currentSlot"), 0, `${label}公开发现结果包含当前局信息`);
    assert.equal(nestedKeyCount(payload, "layoutCommitment"), 0, `${label}公开发现结果包含布局承诺`);
  }
}

function sourceDigest(source) {
  return crypto.createHash("sha256").update(JSON.stringify(source), "utf8").digest("hex");
}

function assertLockedBatchSnapshot(snapshot, source, label, { manualActionsHidden = true } = {}) {
  assert.equal(snapshot?.editorSource, source, `${label}期间编辑器源码发生变化`);
  assert.equal(snapshot?.editorReadOnly, true, `${label}期间编辑器没有保持只读`);
  assert.equal(snapshot?.editorAriaReadOnly, "true", `${label}期间编辑器无障碍只读状态不正确`);
  assert.equal(snapshot?.sourceStateText, "源码已锁定", `${label}期间未显示源码锁定`);
  assert.equal(snapshot?.runDisabled, true, `${label}期间仍可从普通运行按钮启动单局`);
  if (manualActionsHidden) {
    assert.equal(snapshot?.verifierDisplay, "none", `${label}期间仍显示单局服务端校验入口`);
    assert.equal(snapshot?.recordActionsDisplay, "none", `${label}期间仍显示单局提交入口`);
  }
}

function assertFiveSlotBatchTraffic(events, source, teamId) {
  const pairs = pairBatchProbeEvents(events, "五局主流程");
  assert.equal(pairs.length, 12,
    "五局主流程应包含 1 次创建、1 次首局队伍绑定探测、5 次成功租约和 5 次提交");
  const createPair = pairs[0];
  assert.equal(createPair.request.method, "POST");
  assert.equal(createPair.request.path, "/api/v1/evaluation-batches");
  assert.deepEqual(JSON.parse(createPair.request.requestBody || "null"), { source }, "创建批次没有锁定唯一源码");
  assert.equal(createPair.response.status, 201, "五局批次没有成功创建");
  assertLockedBatchSnapshot(createPair.request.snapshot, source, "批次创建请求", { manualActionsHidden: false });
  assertLockedBatchSnapshot(createPair.response.snapshot, source, "批次创建响应", { manualActionsHidden: false });
  const created = parseBatchProbeResponse(createPair.response, "批次创建");
  assertBatchPublicResponsePrivacy(created, { label: "批次创建响应", lockedSource: source });
  assert.equal(created.schemaVersion, "chenlong.batch-api-response/v1");
  assert.equal(created.batch?.phase, "open");
  assert.equal(created.batch?.nextSlotIndex, 1);
  assert.equal(created.batch?.sourceDigest, sourceDigest(source), "服务端锁定源码摘要不匹配");
  const batchId = created.batch.batchId;
  assert.match(batchId, /^bat_[a-f0-9]{32}$/);

  const teamProbePair = pairs[1];
  assert.equal(teamProbePair.request.method, "POST");
  assert.equal(
    teamProbePair.request.path,
    `/api/v1/evaluation-batches/${batchId}/current-slot/lease`,
    "同源幂等兼容探测没有指向首局租约"
  );
  assert.deepEqual(JSON.parse(teamProbePair.request.requestBody || "null"), { slotIndex: 1 },
    "首局兼容探测不应预设队伍编号");
  assert.equal(teamProbePair.response.status, 400, "首局无队伍编号探测没有被服务端明确拒绝");
  assertLockedBatchSnapshot(teamProbePair.request.snapshot, source, "首局队伍绑定探测请求");
  assertLockedBatchSnapshot(teamProbePair.response.snapshot, source, "首局队伍绑定探测响应");
  const teamProbePayload = parseBatchProbeResponse(teamProbePair.response, "首局队伍绑定探测");
  assertBatchPublicResponsePrivacy(teamProbePayload, {
    label: "首局队伍绑定探测响应",
    lockedSource: source
  });
  assert.equal(teamProbePayload.error?.code, "INVALID_TEAM_ID",
    "首局无队伍编号探测没有返回预期错误码");

  const sessionIds = new Set();
  const runIds = new Set();
  const layoutCommitments = new Set();
  const submissions = [];
  for (let slotIndex = 1; slotIndex <= 5; slotIndex += 1) {
    const leasePair = pairs[2 + (slotIndex - 1) * 2];
    const submitPair = pairs[3 + (slotIndex - 1) * 2];
    const leasePath = `/api/v1/evaluation-batches/${batchId}/current-slot/lease`;
    assert.equal(leasePair.request.method, "POST");
    assert.equal(leasePair.request.path, leasePath, `第 ${slotIndex} 局租约路径不正确`);
    assert.deepEqual(
      JSON.parse(leasePair.request.requestBody || "null"),
      { slotIndex, teamId },
      `第 ${slotIndex} 局租约没有绑定当前局和队伍`
    );
    assert.equal(leasePair.response.status, 201, `第 ${slotIndex} 局租约没有新建成功`);
    assertLockedBatchSnapshot(leasePair.request.snapshot, source, `第 ${slotIndex} 局租约请求`);
    assertLockedBatchSnapshot(leasePair.response.snapshot, source, `第 ${slotIndex} 局租约响应`);
    const leasePayload = parseBatchProbeResponse(leasePair.response, `第 ${slotIndex} 局租约`);
    assertBatchPublicResponsePrivacy(leasePayload, {
      label: `第 ${slotIndex} 局租约响应`,
      lockedSource: source,
      expectLease: true
    });
    const lease = leasePayload.lease;
    assert.equal(lease?.batchId, batchId);
    assert.equal(lease?.slotIndex, slotIndex);
    assert.equal(lease?.layout?.slotIndex, slotIndex);
    assert.equal(lease?.recovered, false, `第 ${slotIndex} 局不应是重复租约`);
    assert.equal(lease?.session?.teamId, teamId);
    assert.match(lease?.session?.sessionId || "", /^ses_[a-f0-9]{32}$/);
    assert.match(lease?.session?.runId || "", /^run_[a-f0-9]{32}$/);
    assert.equal(sessionIds.has(lease.session.sessionId), false, `第 ${slotIndex} 局复用了其他局 session`);
    assert.equal(runIds.has(lease.session.runId), false, `第 ${slotIndex} 局复用了其他局 runId`);
    assert.equal(layoutCommitments.has(lease.layout.layoutCommitment), false,
      `第 ${slotIndex} 局复用了其他局布局承诺`);
    sessionIds.add(lease.session.sessionId);
    runIds.add(lease.session.runId);
    layoutCommitments.add(lease.layout.layoutCommitment);

    const submitPath = `/api/v1/evaluation-batches/${batchId}/slots/${slotIndex}`
      + `/sessions/${lease.session.sessionId}/submissions`;
    assert.equal(submitPair.request.method, "POST");
    assert.equal(submitPair.request.path, submitPath, `第 ${slotIndex} 局提交路径没有绑定租约 session`);
    assert.ok(Number(submitPair.request.requestBodyLength) > 0, `第 ${slotIndex} 局没有提交真实运行记录`);
    assert.equal(submitPair.response.status, 201, `第 ${slotIndex} 局没有首次写入成功`);
    assertLockedBatchSnapshot(submitPair.request.snapshot, source, `第 ${slotIndex} 局提交请求`);
    assertLockedBatchSnapshot(submitPair.response.snapshot, source, `第 ${slotIndex} 局服务端确认`);
    const submitted = parseBatchProbeResponse(submitPair.response, `第 ${slotIndex} 局提交`);
    assertBatchPublicResponsePrivacy(submitted, { label: `第 ${slotIndex} 局提交响应`, lockedSource: source });
    assert.equal(submitted.duplicate, false, `第 ${slotIndex} 局意外走了幂等重试`);
    assert.equal(submitted.submission?.verification?.status, "verified", `第 ${slotIndex} 局没有完整复算`);
    assert.equal(submitted.submission?.verification?.replay?.verified, true,
      `第 ${slotIndex} 局没有通过确定性回放`);
    const slots = submitted.batch?.slots || [];
    assert.equal(slots.length, 5);
    for (let previous = 1; previous <= slotIndex; previous += 1) {
      assert.equal(slots[previous - 1]?.final, true, `第 ${slotIndex} 局确认时第 ${previous} 局尚未 final`);
      assert.equal(slots[previous - 1]?.status, "valid", `第 ${previous} 局不是 valid`);
    }
    for (let future = slotIndex + 1; future <= 5; future += 1) {
      assert.equal(slots[future - 1]?.final, false, `第 ${slotIndex} 局确认时未来第 ${future} 局已被提前结算`);
      assert.equal(slots[future - 1]?.status, "pending", `未来第 ${future} 局状态被提前改变`);
    }
    if (slotIndex < 5) {
      assert.equal(submitted.batch.phase, "open");
      assert.equal(submitted.batch.nextSlotIndex, slotIndex + 1);
      assert.equal(submitted.currentSlot?.slotIndex, slotIndex + 1);
    } else {
      assert.equal(submitted.batch.phase, "finalized");
      assert.equal(submitted.batch.nextSlotIndex, null);
      assert.equal(submitted.currentSlot, null);
    }
    submissions.push(submitted);
  }

  assert.equal(sessionIds.size, 5, "五局没有使用五个独立服务端 session");
  assert.equal(runIds.size, 5, "五局没有使用五个独立 runId");
  assert.equal(layoutCommitments.size, 5, "五局布局承诺没有做到不重复");
  return { batchId, created, submissions, finalized: submissions[4].batch };
}

function pathFromRequestEntry(entry) {
  try {
    const url = new URL(entry.url);
    return `${url.pathname}${url.search}`;
  } catch (_error) {
    return "";
  }
}

function assertFiveSlotCdpRequests(diagnostics, startIndex, probeEvents) {
  const actual = diagnostics.requests.slice(startIndex)
    .filter(entry => pathFromRequestEntry(entry).startsWith("/api/v1/evaluation-batches"))
    .map(entry => ({ method: entry.method, path: pathFromRequestEntry(entry) }));
  const expected = probeEvents
    .filter(event => event.phase === "request")
    .map(event => ({ method: event.method, path: event.path }));
  assert.deepEqual(actual, expected, "页面探针记录与 Chrome 实际五局网络请求不一致");
  assert.equal(actual.filter(item => /\/current-slot\/lease$/.test(item.path)).length, 6,
    "Chrome 应发出 1 次首局队伍绑定探测和恰好 5 次成功当前局租约请求");
  assert.equal(actual.filter(item => /\/slots\/[1-5]\/sessions\/ses_[a-f0-9]{32}\/submissions$/.test(item.path)).length, 5,
    "Chrome 没有恰好发出 5 次逐局提交请求");
  const ordinaryPosts = diagnostics.requests.slice(startIndex).filter(entry => {
    if (entry.method !== "POST") return false;
    const requestPath = pathFromRequestEntry(entry);
    return requestPath === "/api/v1/sessions"
      || /^\/api\/v1\/sessions\/ses_[a-f0-9]{32}\/submissions$/.test(requestPath);
  });
  assert.deepEqual(ordinaryPosts, [], "五局模式仍触发了单局场次或手动提交网络路径");
}

async function runFiveSlotBatchSmoke(page, diagnostics) {
  log("五局烟测：等待本地 Python 与空批次发现结果");
  await waitForPython(page);
  await page.waitForValue(`(() => {
    const panel = document.querySelector("#competitionBatchPanel");
    const status = document.querySelector("#competitionBatchStatus")?.textContent?.trim() || "";
    return panel?.dataset?.state === "idle" && /未发现未完成练习/.test(status) ? status : "";
  })()`, "初始未完成批次发现结束", { timeoutMs: 30_000 });
  await installBatchFetchProbe(page);
  await resetBatchFetchProbe(page);
  await page.fill("#pythonEditor", BATCH_SMOKE_SOURCE);
  await page.waitForValue(
    `document.querySelector("#startCompetitionBatchButton")?.disabled === false`,
    "五局评测按钮可用",
    { timeoutMs: 10_000 }
  );
  const instrumentationReady = await page.evaluate(`(() => {
    const button = document.querySelector("#startCompetitionBatchButton");
    if (!button) return false;
    globalThis.__chenlongBatchStartClickCount = 0;
    button.addEventListener("click", () => { globalThis.__chenlongBatchStartClickCount += 1; });
    return true;
  })()`);
  assert.equal(instrumentationReady, true, "无法记录五局评测按钮点击次数");

  const requestStartIndex = diagnostics.requests.length;
  log("五局烟测：真人点击一次，随后只等待页面自动串行推进");
  await page.click("#startCompetitionBatchButton");
  const activeUi = await page.waitForValue(`(() => {
    const panel = document.querySelector("#competitionBatchPanel");
    const editor = document.querySelector("#pythonEditor");
    const hud = document.querySelector("#competitionHud");
    if (!editor?.readOnly || hud?.dataset?.batchActive !== "true") return null;
    return {
      state: panel?.dataset?.state || "",
      source: editor.value,
      verifierDisplay: getComputedStyle(document.querySelector(".competition-verifier")).display,
      recordActionsDisplay: getComputedStyle(document.querySelector(".competition-record-actions")).display,
      runDisabled: Boolean(document.querySelector("#runButton")?.disabled)
    };
  })()`, "五局源码锁定并隐藏单局路径", { timeoutMs: 30_000 });
  assert.equal(activeUi.source, BATCH_SMOKE_SOURCE);
  assert.equal(activeUi.verifierDisplay, "none", "五局运行期间仍显示单局校验区");
  assert.equal(activeUi.recordActionsDisplay, "none", "五局运行期间仍显示单局手动提交区");
  assert.equal(activeUi.runDisabled, true, "五局运行期间普通运行按钮仍可用");

  const finalState = await page.waitForValue(`(() => {
    const panel = document.querySelector("#competitionBatchPanel");
    const status = document.querySelector("#competitionBatchStatus")?.textContent?.trim() || "";
    if (panel?.dataset?.state === "error") return { error: status || "五局评测进入错误状态" };
    const batch = activeCompetitionBatch?.batch;
    if (panel?.dataset?.state !== "finalized" || batch?.phase !== "finalized") return null;
    return {
      phase: batch.phase,
      slots: batch.slots.map(slot => ({
        slotIndex: slot.slotIndex,
        final: slot.final,
        status: slot.status,
        score: slot.score,
        completed: slot.completed
      })),
      summary: structuredClone(batch.summary),
      sourceDigest: batch.sourceDigest,
      editorSource: document.querySelector("#pythonEditor")?.value || "",
      editorReadOnly: Boolean(document.querySelector("#pythonEditor")?.readOnly),
      sourceState: document.querySelector("#competitionBatchSourceState")?.textContent?.trim() || "",
      panelState: panel.dataset.state,
      panelStatus: status,
      slotText: document.querySelector("#competitionBatchSlot")?.textContent?.trim() || "",
      stateText: document.querySelector("#competitionBatchState")?.textContent?.trim() || "",
      currentScoreText: document.querySelector("#competitionBatchCurrentScore")?.textContent?.trim() || "",
      meanText: document.querySelector("#competitionBatchMeanScore")?.textContent?.trim() || "",
      minimumText: document.querySelector("#competitionBatchMinimumScore")?.textContent?.trim() || "",
      batchScoreText: document.querySelector("#competitionBatchScore")?.textContent?.trim() || "",
      output: document.querySelector("#pythonOutputContent")?.textContent || "",
      startClickCount: globalThis.__chenlongBatchStartClickCount,
      ordinarySubmissionCount: latestCompetitionSubmissionReceipt ? 1 : 0
    };
  })()`, "五局全部经服务端确认并显示最终汇总", {
    timeoutMs: BATCH_SMOKE_TIMEOUT_MS,
    intervalMs: 50,
    accept: value => Boolean(value?.error || value?.phase === "finalized")
  });
  assert.equal(finalState.error, undefined, finalState.error || "五局评测失败");
  await page.waitForValue(
    `typeof competitionBatchOperation !== "undefined" && competitionBatchOperation === null`,
    "五局自动串行操作完全结束",
    { timeoutMs: 10_000 }
  );

  const probeEvents = await readBatchFetchProbe(page);
  const traffic = assertFiveSlotBatchTraffic(probeEvents, BATCH_SMOKE_SOURCE, "local-user");
  assertFiveSlotCdpRequests(diagnostics, requestStartIndex, probeEvents);
  assert.equal(finalState.startClickCount, 1, "五局主流程不是由且仅由一次真人点击启动");
  assert.equal(finalState.phase, "finalized");
  assert.equal(finalState.panelState, "finalized");
  assert.equal(finalState.stateText, "练习五局完成");
  assert.equal(finalState.slotText, "第 5 / 5 局");
  assert.match(finalState.panelStatus, /五局均已完成|最终分数来自服务端公开汇总/);
  assert.equal(finalState.editorSource, BATCH_SMOKE_SOURCE, "五局结束后源码被改写");
  assert.equal(finalState.editorReadOnly, false, "五局结束后编辑器没有解除只读");
  assert.equal(finalState.sourceState, "源码未锁定", "五局结束后源码锁定提示没有复位");
  assert.equal(finalState.sourceDigest, sourceDigest(BATCH_SMOKE_SOURCE));
  assert.equal(finalState.slots.length, 5);
  assert.deepEqual(finalState.slots.map(slot => slot.slotIndex), [1, 2, 3, 4, 5]);
  assert.deepEqual(finalState.slots.map(slot => slot.final), [true, true, true, true, true]);
  assert.deepEqual(finalState.slots.map(slot => slot.status), ["valid", "valid", "valid", "valid", "valid"]);
  assert.equal(finalState.summary.finalizedCount, 5);
  assert.equal(finalState.summary.pendingCount, 0);
  assert.equal(finalState.summary.validCount, 5);
  assert.equal(finalState.summary.invalidCount, 0);
  assert.equal(finalState.summary.timeoutCount, 0);
  assert.equal(finalState.summary.missingCount, 0);
  const exactMeanScore = finalState.slots.reduce((sum, slot) => sum + slot.score, 0) / 5;
  const exactMinimumScore = Math.min(...finalState.slots.map(slot => slot.score));
  const roundedMeanScore = Math.round((exactMeanScore + Number.EPSILON) * 100) / 100;
  const roundedMinimumScore = Math.round((exactMinimumScore + Number.EPSILON) * 100) / 100;
  const expectedBatchScore = Math.round((0.70 * exactMeanScore
    + 0.30 * exactMinimumScore + Number.EPSILON) * 100) / 100;
  assert.equal(finalState.summary.meanScore, roundedMeanScore, "最终均分没有覆盖全部 5 局");
  assert.equal(finalState.summary.minScore, roundedMinimumScore, "最终最低分没有覆盖全部 5 局");
  assert.equal(finalState.summary.batchScore, expectedBatchScore, "最终分数不是 70% 均分 + 30% 最低分");
  assert.equal(finalState.meanText, `${finalState.summary.meanScore.toFixed(2)} / 100`);
  assert.equal(finalState.minimumText, `${finalState.summary.minScore.toFixed(2)} / 100`);
  assert.equal(finalState.batchScoreText, `${finalState.summary.batchScore.toFixed(2)} / 100`);
  assert.match(finalState.currentScoreText, /^\d+(?:\.\d)? \/ 100$/);
  assert.match(finalState.output, /browser-e2e-batch\s+0(?:\.0+)?/, "最后一局没有执行锁定的短源码");
  assert.equal(finalState.ordinarySubmissionCount, 0, "五局模式意外生成了单局手动提交回执");
  assert.deepEqual(finalState.summary, traffic.finalized.summary, "页面最终汇总与最后一次服务端确认不一致");
  return { finalState, traffic };
}

async function clickAndAcceptConfirm(page, diagnostics, selector, expectedMessage) {
  const dialogPromise = page.connection.waitForEvent(
    "Page.javascriptDialogOpening",
    (_params, sessionId) => sessionId === page.sessionId,
    10_000
  );
  let clickError = null;
  const clickPromise = page.click(selector).catch(error => { clickError = error; });
  const dialog = await dialogPromise;
  assert.equal(dialog.type, "confirm", `${selector}没有打开确认对话框`);
  assert.match(dialog.message || "", expectedMessage, `${selector}确认文案不正确`);
  await page.send("Page.handleJavaScriptDialog", { accept: true });
  await clickPromise;
  if (clickError) throw clickError;
  const matchingDialogIndex = diagnostics.dialogs.findIndex(item => (
    item.type === dialog.type && item.message === dialog.message
  ));
  assert.notEqual(matchingDialogIndex, -1, "Chrome 诊断没有记录显式关闭确认框");
  diagnostics.dialogs.splice(matchingDialogIndex, 1);
}

async function testLostBatchDiscoveryAndClose(page, connection, origin, downloadsDir, diagnostics) {
  log("五局烟测：创建一个不运行的批次，验证空 sessionStorage 页面只发现、不自动运行");
  const created = await page.evaluate(`fetch("/api/v1/evaluation-batches", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ source: ${JSON.stringify(BATCH_DISCOVERY_LOST_SOURCE)} })
  }).then(async response => ({ status: response.status, payload: await response.json() }))`, 30_000);
  assert.equal(created.status, 201, "遗失批次测试夹具没有创建成功");
  assert.equal(created.payload?.batch?.phase, "open");
  assert.equal(created.payload?.batch?.nextSlotIndex, 1);
  assertBatchPublicResponsePrivacy(created.payload, {
    label: "遗失批次创建响应",
    lockedSource: BATCH_DISCOVERY_LOST_SOURCE
  });
  const lostBatchId = created.payload.batch.batchId;

  const recoveryPage = await createPage(connection, origin, downloadsDir, diagnostics);
  await recoveryPage.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "try { sessionStorage.clear(); } catch (_error) {}"
  });
  await installBatchFetchProbe(recoveryPage);
  const recoveryRequestStart = diagnostics.requests.length;
  await recoveryPage.navigate(`${origin}/`);
  await waitForPython(recoveryPage);
  const discovered = await recoveryPage.waitForValue(`(() => {
    const panel = document.querySelector("#competitionBatchRecoveryPanel");
    const buttons = [...document.querySelectorAll("#competitionBatchRecoveryItems button")];
    const status = document.querySelector("#competitionBatchStatus")?.textContent?.trim() || "";
    if (!panel || panel.hidden || buttons.length !== 1 || buttons[0].dataset.action !== "close") return null;
    return {
      status,
      editorSource: document.querySelector("#pythonEditor")?.value || "",
      action: buttons[0].dataset.action,
      label: buttons[0].textContent?.trim() || "",
      candidateCount: competitionBatchDiscoveryCandidates.length,
      activeBatch: activeCompetitionBatch !== null,
      operationActive: Boolean(competitionBatchOperation),
      running: Boolean(running),
      runState: document.querySelector("#competitionRunState")?.textContent?.trim() || ""
    };
  })()`, "空 sessionStorage 页面发现 owner 的遗失批次", { timeoutMs: 30_000 });
  assert.match(discovered.status, /当前源码不同|逐个确认关闭/);
  assert.notEqual(discovered.editorSource.trim(), BATCH_DISCOVERY_LOST_SOURCE,
    "空 sessionStorage 页面不应凭空恢复遗失批次的锁定源码");
  assert.equal(discovered.action, "close");
  assert.equal(discovered.label, "关闭遗失练习");
  assert.equal(discovered.candidateCount, 1);
  assert.equal(discovered.activeBatch, false, "owner discovery 自动恢复了批次");
  assert.equal(discovered.operationActive, false, "owner discovery 自动启动了批次序列");
  assert.equal(discovered.running, false, "owner discovery 自动运行了 Python");
  assert.notEqual(discovered.runState, "计时运行中");
  await delay(750);

  let events = await readBatchFetchProbe(recoveryPage);
  let pairs = pairBatchProbeEvents(events, "遗失批次发现");
  assert.equal(pairs.length, 1, "遗失批次发现阶段只能请求一次 owner open 列表");
  assert.equal(pairs[0].request.method, "GET");
  assert.equal(pairs[0].request.path, "/api/v1/evaluation-batches?phase=open");
  assert.equal(pairs[0].response.status, 200);
  const openList = parseBatchProbeResponse(pairs[0].response, "owner open 批次列表");
  assertBatchPublicResponsePrivacy(openList, {
    label: "owner open 批次列表",
    lockedSource: BATCH_DISCOVERY_LOST_SOURCE,
    expectOpenList: true
  });
  assert.deepEqual(openList.batches.map(item => item.batchId), [lostBatchId]);
  assert.equal(openList.batches[0].nextSlotIndex, 1);
  assert.equal(nestedKeyCount(openList, "sessionId"), 0, "owner discovery 泄露了 sessionId");
  assert.equal(nestedKeyCount(openList, "runId"), 0, "owner discovery 泄露了 runId");
  const beforeCloseRequests = diagnostics.requests.slice(recoveryRequestStart)
    .filter(entry => pathFromRequestEntry(entry).startsWith("/api/v1/evaluation-batches"));
  assert.deepEqual(beforeCloseRequests.map(entry => ({ method: entry.method, path: pathFromRequestEntry(entry) })), [
    { method: "GET", path: "/api/v1/evaluation-batches?phase=open" }
  ], "空 sessionStorage 页面在显式操作前请求了租约或提交");

  await clickAndAcceptConfirm(
    recoveryPage,
    diagnostics,
    '#competitionBatchRecoveryItems button[data-action="close"]',
    /确定关闭这个遗失的练习五局.*missing \/ 0 分/
  );
  await recoveryPage.waitForValue(`(() => {
    const panel = document.querySelector("#competitionBatchRecoveryPanel");
    const status = document.querySelector("#competitionBatchStatus")?.textContent?.trim() || "";
    return panel?.hidden && /未发现未完成练习/.test(status) ? status : "";
  })()`, "显式关闭遗失批次并刷新 owner open 列表", { timeoutMs: 30_000 });

  events = await readBatchFetchProbe(recoveryPage);
  pairs = pairBatchProbeEvents(events, "遗失批次显式关闭");
  assert.equal(pairs.length, 3, "遗失批次流程应为发现、显式关闭、再次发现三次请求");
  assert.deepEqual(pairs.map(pair => ({ method: pair.request.method, path: pair.request.path })), [
    { method: "GET", path: "/api/v1/evaluation-batches?phase=open" },
    { method: "POST", path: `/api/v1/evaluation-batches/${lostBatchId}/close` },
    { method: "GET", path: "/api/v1/evaluation-batches?phase=open" }
  ]);
  const closed = parseBatchProbeResponse(pairs[1].response, "遗失批次关闭响应");
  assert.equal(pairs[1].response.status, 200);
  assertBatchPublicResponsePrivacy(closed, {
    label: "遗失批次关闭响应",
    lockedSource: BATCH_DISCOVERY_LOST_SOURCE
  });
  assert.equal(closed.batch.phase, "finalized");
  assert.deepEqual(closed.batch.slots.map(slot => slot.status), ["missing", "missing", "missing", "missing", "missing"]);
  const emptyList = parseBatchProbeResponse(pairs[2].response, "关闭后的 owner open 批次列表");
  assertBatchPublicResponsePrivacy(emptyList, {
    label: "关闭后的 owner open 批次列表",
    lockedSource: BATCH_DISCOVERY_LOST_SOURCE,
    expectOpenList: true
  });
  assert.deepEqual(emptyList.batches, []);
  const recoveryBatchRequests = diagnostics.requests.slice(recoveryRequestStart)
    .filter(entry => pathFromRequestEntry(entry).startsWith("/api/v1/evaluation-batches"));
  assert.deepEqual(
    recoveryBatchRequests.map(entry => ({ method: entry.method, path: pathFromRequestEntry(entry) })),
    pairs.map(pair => ({ method: pair.request.method, path: pair.request.path })),
    "owner discovery 页面探针与 Chrome 实际请求不一致"
  );
  assert.equal(recoveryBatchRequests.some(entry => /\/current-slot\/lease$/.test(pathFromRequestEntry(entry))), false,
    "owner discovery 在显式关闭前后自动领取了当前局");
  assert.equal(recoveryBatchRequests.some(entry => /\/slots\/[1-5]\/sessions\/.+\/submissions$/.test(pathFromRequestEntry(entry))), false,
    "owner discovery 在显式关闭前后自动提交了局记录");
}

async function runBatchEvaluationSmoke(page, connection, origin, downloadsDir, diagnostics) {
  const main = await runFiveSlotBatchSmoke(page, diagnostics);
  await testLostBatchDiscoveryAndClose(page, connection, origin, downloadsDir, diagnostics);
  return main;
}

function assertRankedLockedSnapshot(snapshot, source, teamId, label) {
  assert.equal(snapshot?.editorSource, source, `${label}期间编辑器源码发生变化`);
  assert.equal(snapshot?.editorReadOnly, true, `${label}期间编辑器没有保持只读`);
  assert.equal(snapshot?.editorAriaReadOnly, "true", `${label}期间编辑器无障碍只读状态不正确`);
  assert.equal(snapshot?.teamInput, teamId, `${label}期间队伍编号发生变化`);
  assert.equal(snapshot?.teamDisabled, true, `${label}期间队伍编号仍可编辑`);
  assert.equal(snapshot?.activeSource, source, `${label}期间活动筛选没有锁定源码`);
  assert.equal(snapshot?.activeTeamId, teamId, `${label}期间活动筛选没有锁定队伍`);
  assert.equal(snapshot?.sourceStateText, "源码已锁定", `${label}期间未显示源码锁定`);
  assert.equal(snapshot?.runDisabled, true, `${label}期间普通运行按钮仍可启动单局`);
  assert.equal(snapshot?.startHidden, true, `${label}期间仍显示新建筛选入口`);
  assert.equal(snapshot?.verifierDisplay, "none", `${label}期间仍显示普通单局校验入口`);
  assert.equal(snapshot?.recordActionsDisplay, "none", `${label}期间仍显示普通单局提交入口`);
  assert.equal(snapshot?.ordinarySubmissionReceipt, false, `${label}期间生成了普通单局提交回执`);
}

function assertRankedLayoutBoundary(payload, {
  label,
  expectLease = false,
  currentSlotIndex = null
}) {
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload), `${label}不是 JSON 对象`);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(
    serialized,
    /"(?:futureLayouts|layouts|layoutId|layoutIds|layoutSequence|runDefinitions|privateLayouts|privateLayoutSelection|privateLayoutSequence|anchorIds?|layoutCatalog|seedDigest|sourcePosition|privateValue)"|gyi-v2-t\d+d\d+o\d+/,
    `${label}泄露了未来布局或私有布局目录`
  );
  const runDefinitionCount = nestedKeyCount(payload, "runDefinition");
  const interactionDefinitionCount = nestedKeyCount(payload, "interactionDefinition");
  if (expectLease) {
    assert.equal(runDefinitionCount, 1, `${label}必须且只能下发当前一局运行定义`);
    assert.equal(interactionDefinitionCount, 1, `${label}必须且只能下发当前一局交互定义`);
    assert.equal(payload.lease?.slotIndex, currentSlotIndex, `${label}租约不是当前局`);
    assert.equal(payload.lease?.layout?.slotIndex, currentSlotIndex, `${label}布局摘要不是当前局`);
    assert.equal(payload.lease?.runDefinition?.interactionDefinition?.packages?.length, 3,
      `${label}当前局没有且仅有三类物体`);
    assert.deepEqual(
      [...new Set(payload.lease.runDefinition.interactionDefinition.packages.map(item => item?.role))].sort(),
      ["distractor", "obstacle", "target"],
      `${label}当前局三类物体角色不完整`
    );
  } else {
    assert.equal(runDefinitionCount, 0, `${label}不应下发运行定义`);
    assert.equal(interactionDefinitionCount, 0, `${label}不应下发交互定义`);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "lease"), false, `${label}意外包含局租约`);
  }
  const commitments = nestedKeyValues(payload, "layoutCommitment")
    .filter(value => typeof value === "string");
  const uniqueCommitments = new Set(commitments);
  assert.ok(uniqueCommitments.size <= 1, `${label}同时包含多局布局承诺`);
  if (currentSlotIndex === null) {
    assert.equal(commitments.length, 0, `${label}结算后仍包含当前布局承诺`);
  } else {
    assert.equal(uniqueCommitments.size, 1, `${label}缺少当前局布局承诺`);
  }
}

function assertRankedOwnerResponse(payload, {
  label,
  source,
  teamId,
  batchId = null,
  createdAt = null,
  expiresAt = null,
  expectLease = false,
  currentSlotIndex = null
}) {
  assert.equal(payload?.schemaVersion, "chenlong.ranked-evaluation-api/v1", `${label}协议版本不匹配`);
  assert.equal(payload?.authoritative, false, `${label}没有声明 authoritative: false`);
  assert.equal(payload?.competition?.competitionId, RANKED_COMPETITION_ID, `${label}赛季编号不匹配`);
  assert.equal(payload?.competition?.purpose, "ranked", `${label}用途不是 ranked`);
  assert.equal(payload?.competition?.scoreMaximum, 100, `${label}满分不是 100`);
  const evaluation = payload?.evaluation;
  assert.equal(evaluation?.purpose, "ranked", `${label}筛选用途不匹配`);
  assert.equal(evaluation?.competitionId, RANKED_COMPETITION_ID, `${label}筛选赛季不匹配`);
  assert.equal(evaluation?.lockedSource, source, `${label}没有返回账号锁定源码`);
  assert.equal(evaluation?.lockedTeamId, teamId, `${label}没有返回账号锁定队伍`);
  assert.equal(evaluation?.batch?.sourceDigest, sourceDigest(source), `${label}锁定源码摘要不匹配`);
  assert.equal(evaluation?.batch?.slotCount, 5, `${label}不是固定五局`);
  assert.equal(evaluation?.evaluationPolicy?.slotCount, 5, `${label}冻结规则不是固定五局`);
  assert.equal(evaluation?.evaluationPolicy?.scoreMaximum, 100, `${label}冻结规则满分不是 100`);
  assert.match(evaluation?.anonymousParticipantId || "", /^participant_[a-f0-9]{32}$/,
    `${label}匿名参赛编号不正确`);
  assert.match(evaluation?.createdAt || "", /^\d{4}-\d{2}-\d{2}T/, `${label}缺少创建时间`);
  assert.match(evaluation?.expiresAt || "", /^\d{4}-\d{2}-\d{2}T/, `${label}缺少服务器截止时间`);
  assert.ok(Date.parse(evaluation.expiresAt) > Date.parse(evaluation.createdAt), `${label}截止时间无效`);
  if (batchId !== null) assert.equal(evaluation.batch.batchId, batchId, `${label}批次编号发生变化`);
  if (createdAt !== null) assert.equal(evaluation.createdAt, createdAt, `${label}创建时间发生变化`);
  if (expiresAt !== null) assert.equal(evaluation.expiresAt, expiresAt, `${label}截止时间发生变化`);
  if (currentSlotIndex === null) {
    assert.equal(evaluation.currentSlot, null, `${label}不应包含当前局摘要`);
  } else {
    assert.equal(evaluation.currentSlot?.slotIndex, currentSlotIndex, `${label}当前局摘要不匹配`);
    assert.equal(evaluation.currentSlot?.sequenceLength, 5, `${label}当前局序列长度不匹配`);
  }
  assertRankedLayoutBoundary(payload, { label, expectLease, currentSlotIndex });
  return evaluation;
}

function assertRankedBatchSummary(batch, label) {
  assert.equal(batch?.phase, "finalized", `${label}没有完成结算`);
  assert.equal(batch?.summary?.slotCount, 5, `${label}不是五局汇总`);
  assert.equal(batch?.summary?.finalizedCount, 5, `${label}没有结算全部五局`);
  assert.equal(batch?.summary?.pendingCount, 0, `${label}仍有待处理局`);
  assert.equal(batch?.summary?.validCount, 5, `${label}没有得到五个 valid`);
  assert.equal(batch?.summary?.invalidCount, 0, `${label}出现 invalid 局`);
  assert.equal(batch?.summary?.timeoutCount, 0, `${label}出现 timeout 局`);
  assert.equal(batch?.summary?.missingCount, 0, `${label}出现 missing 局`);
  assert.deepEqual(batch?.slots?.map(slot => slot.slotIndex), [1, 2, 3, 4, 5], `${label}局序号不完整`);
  assert.deepEqual(batch?.slots?.map(slot => slot.status), Array(5).fill("valid"), `${label}局状态不全为 valid`);
  assert.deepEqual(batch?.slots?.map(slot => slot.final), Array(5).fill(true), `${label}存在未 final 的局`);
  const scores = batch.slots.map(slot => slot.score);
  const exactMean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const exactMinimum = Math.min(...scores);
  const expectedMean = Math.round((exactMean + Number.EPSILON) * 100) / 100;
  const expectedMinimum = Math.round((exactMinimum + Number.EPSILON) * 100) / 100;
  const expectedScore = Math.round((0.70 * exactMean + 0.30 * exactMinimum + Number.EPSILON) * 100) / 100;
  assert.equal(batch.summary.meanScore, expectedMean, `${label}均分没有覆盖五局`);
  assert.equal(batch.summary.minScore, expectedMinimum, `${label}最低分没有覆盖五局`);
  assert.equal(batch.summary.batchScore, expectedScore, `${label}总分不是 70% 均分 + 30% 最低分`);
}

function assertRankedMainTraffic(events, source, teamId) {
  const pairs = pairBatchProbeEvents(events, "筛选五局主流程");
  assert.equal(pairs.length, 12, "筛选五局主流程应为 1 次创建、5 次租约、5 次提交和 1 次最终 /me");
  const createPair = pairs[0];
  assert.equal(createPair.request.method, "POST");
  assert.equal(createPair.request.path, RANKED_EVALUATION_PATH);
  assert.deepEqual(JSON.parse(createPair.request.requestBody || "null"), { source, teamId },
    "筛选创建没有同时锁定源码和队伍");
  assert.equal(createPair.response.status, 201, "唯一一次筛选没有成功创建");
  assertRankedLockedSnapshot(createPair.request.snapshot, source, teamId, "筛选创建请求");
  assertRankedLockedSnapshot(createPair.response.snapshot, source, teamId, "筛选创建响应");
  const createdPayload = parseBatchProbeResponse(createPair.response, "筛选创建");
  assert.equal(createdPayload.created, true, "新隔离账号没有消耗一次全新机会");
  const created = assertRankedOwnerResponse(createdPayload, {
    label: "筛选创建响应",
    source,
    teamId,
    currentSlotIndex: 1
  });
  assert.equal(created.batch.phase, "open");
  assert.equal(created.batch.nextSlotIndex, 1);
  assert.equal(created.result, null);
  const { batchId } = created.batch;
  const { createdAt, expiresAt, anonymousParticipantId } = created;
  assert.match(batchId, /^bat_[a-f0-9]{32}$/);

  const sessionIds = new Set();
  const runIds = new Set();
  const layoutCommitments = new Set();
  let latestSubmission = null;
  for (let slotIndex = 1; slotIndex <= 5; slotIndex += 1) {
    const leasePair = pairs[1 + (slotIndex - 1) * 2];
    const submitPair = pairs[2 + (slotIndex - 1) * 2];
    const leasePath = `${RANKED_EVALUATION_PATH}/${batchId}/current-slot/lease`;
    assert.equal(leasePair.request.method, "POST");
    assert.equal(leasePair.request.path, leasePath, `筛选第 ${slotIndex} 局租约路径不正确`);
    assert.deepEqual(JSON.parse(leasePair.request.requestBody || "null"), { slotIndex },
      `筛选第 ${slotIndex} 局租约请求包含非当前局字段`);
    assert.equal(leasePair.response.status, 201, `筛选第 ${slotIndex} 局没有创建新租约`);
    assertRankedLockedSnapshot(leasePair.request.snapshot, source, teamId, `筛选第 ${slotIndex} 局租约请求`);
    assertRankedLockedSnapshot(leasePair.response.snapshot, source, teamId, `筛选第 ${slotIndex} 局租约响应`);
    const leasePayload = parseBatchProbeResponse(leasePair.response, `筛选第 ${slotIndex} 局租约`);
    const leaseEvaluation = assertRankedOwnerResponse(leasePayload, {
      label: `筛选第 ${slotIndex} 局租约响应`,
      source,
      teamId,
      batchId,
      createdAt,
      expiresAt,
      expectLease: true,
      currentSlotIndex: slotIndex
    });
    assert.equal(leaseEvaluation.result, null);
    const lease = leasePayload.lease;
    assert.equal(lease.recovered, false, `筛选第 ${slotIndex} 局意外复用了旧租约`);
    assert.equal(lease.session.teamId, teamId, `筛选第 ${slotIndex} 局 session 队伍不正确`);
    assert.match(lease.session.sessionId, /^ses_[a-f0-9]{32}$/);
    assert.match(lease.session.runId, /^run_[a-f0-9]{32}$/);
    assert.equal(sessionIds.has(lease.session.sessionId), false, `筛选第 ${slotIndex} 局复用了 session`);
    assert.equal(runIds.has(lease.session.runId), false, `筛选第 ${slotIndex} 局复用了 runId`);
    assert.equal(layoutCommitments.has(lease.layout.layoutCommitment), false,
      `筛选第 ${slotIndex} 局复用了布局承诺`);
    sessionIds.add(lease.session.sessionId);
    runIds.add(lease.session.runId);
    layoutCommitments.add(lease.layout.layoutCommitment);

    const submitPath = `${RANKED_EVALUATION_PATH}/${batchId}/slots/${slotIndex}`
      + `/sessions/${lease.session.sessionId}/submissions`;
    assert.equal(submitPair.request.method, "POST");
    assert.equal(submitPair.request.path, submitPath, `筛选第 ${slotIndex} 局提交路径没有绑定租约`);
    assert.ok(Number(submitPair.request.requestBodyLength) > 0, `筛选第 ${slotIndex} 局没有提交真实记录`);
    assert.deepEqual(submitPair.request.recordIdentity, {
      schemaVersion: "chenlong.run-record/v4",
      runId: lease.session.runId,
      serverSessionId: lease.session.sessionId,
      challengeDigest: lease.session.challengeDigest,
      teamId,
      sourceCode: source
    }, `筛选第 ${slotIndex} 局记录没有锁定到唯一源码、队伍和租约`);
    assert.equal(submitPair.response.status, 201, `筛选第 ${slotIndex} 局没有首次写入成功`);
    assertRankedLockedSnapshot(submitPair.request.snapshot, source, teamId, `筛选第 ${slotIndex} 局提交请求`);
    assertRankedLockedSnapshot(submitPair.response.snapshot, source, teamId, `筛选第 ${slotIndex} 局提交响应`);
    const submittedPayload = parseBatchProbeResponse(submitPair.response, `筛选第 ${slotIndex} 局提交`);
    const nextSlotIndex = slotIndex < 5 ? slotIndex + 1 : null;
    const submitted = assertRankedOwnerResponse(submittedPayload, {
      label: `筛选第 ${slotIndex} 局提交响应`,
      source,
      teamId,
      batchId,
      createdAt,
      expiresAt,
      currentSlotIndex: nextSlotIndex
    });
    assert.equal(submittedPayload.duplicate, false, `筛选第 ${slotIndex} 局意外走幂等重试`);
    assert.equal(submittedPayload.submission?.verification?.status, "verified",
      `筛选第 ${slotIndex} 局没有完整复算`);
    assert.equal(submittedPayload.submission?.verification?.replay?.verified, true,
      `筛选第 ${slotIndex} 局没有通过确定性回放`);
    for (let previous = 1; previous <= slotIndex; previous += 1) {
      assert.equal(submitted.batch.slots[previous - 1]?.final, true,
        `筛选第 ${slotIndex} 局确认时第 ${previous} 局尚未 final`);
      assert.equal(submitted.batch.slots[previous - 1]?.status, "valid", `筛选第 ${previous} 局不是 valid`);
    }
    for (let future = slotIndex + 1; future <= 5; future += 1) {
      assert.equal(submitted.batch.slots[future - 1]?.final, false,
        `筛选第 ${slotIndex} 局确认时未来第 ${future} 局已提前结算`);
      assert.equal(submitted.batch.slots[future - 1]?.status, "pending",
        `筛选第 ${slotIndex} 局确认时未来第 ${future} 局状态已改变`);
    }
    if (slotIndex < 5) {
      assert.equal(submitted.batch.phase, "open");
      assert.equal(submitted.batch.nextSlotIndex, slotIndex + 1);
      assert.equal(submitted.result, null);
    } else {
      assertRankedBatchSummary(submitted.batch, "筛选第五局提交响应");
      assert.equal(submitted.currentSlot, null);
      assert.equal(submitted.result?.rank, 1, "隔离筛选账号最终名次不是第 1 名");
      assert.equal(submitted.result?.score?.maximum, 100, "筛选名次没有使用 100 分制");
      assert.equal(submitted.result?.score?.value, submitted.batch.summary.batchScore,
        "筛选名次分数与五局汇总不一致");
    }
    latestSubmission = submitted;
  }
  assert.equal(sessionIds.size, 5, "筛选五局没有使用五个独立 session");
  assert.equal(runIds.size, 5, "筛选五局没有使用五个独立 runId");
  assert.equal(layoutCommitments.size, 5, "筛选五局没有使用五个不同当前局承诺");

  const mePair = pairs[11];
  assert.equal(mePair.request.method, "GET");
  assert.equal(mePair.request.path, `${RANKED_EVALUATION_PATH}/me`);
  assertRankedLockedSnapshot(mePair.request.snapshot, source, teamId, "筛选最终 /me 请求");
  assertRankedLockedSnapshot(mePair.response.snapshot, source, teamId, "筛选最终 /me 响应");
  assert.equal(mePair.response.status, 200);
  const finalPayload = parseBatchProbeResponse(mePair.response, "筛选最终 /me");
  const finalized = assertRankedOwnerResponse(finalPayload, {
    label: "筛选最终 /me 响应",
    source,
    teamId,
    batchId,
    createdAt,
    expiresAt,
    currentSlotIndex: null
  });
  assertRankedBatchSummary(finalized.batch, "筛选最终 /me 响应");
  assert.equal(finalized.result?.rank, 1, "隔离筛选账号最终名次不是第 1 名");
  assert.equal(finalized.result?.anonymousParticipantId, anonymousParticipantId,
    "筛选匿名参赛编号在结算时发生变化");
  assert.equal(finalized.result?.score?.maximum, 100, "最终名次没有使用 100 分制");
  assert.equal(finalized.result?.score?.value, finalized.batch.summary.batchScore,
    "最终名次分数与五局汇总不一致");
  assert.deepEqual(finalized.batch.summary, latestSubmission.batch.summary,
    "最终 /me 与第五局服务端确认的汇总不一致");
  return { pairs, batchId, createdAt, expiresAt, anonymousParticipantId, finalized };
}

function assertRankedCdpMainTraffic(diagnostics, startIndex, probeEvents) {
  const actual = diagnostics.requests.slice(startIndex)
    .filter(entry => pathFromRequestEntry(entry).startsWith(RANKED_EVALUATION_PATH))
    .map(entry => ({ method: entry.method, path: pathFromRequestEntry(entry) }));
  const expected = probeEvents
    .filter(event => event.phase === "request")
    .map(event => ({ method: event.method, path: event.path }));
  assert.deepEqual(actual, expected, "页面探针记录与 Chrome 实际筛选五局请求不一致");
  assert.equal(actual.filter(item => /\/current-slot\/lease$/.test(item.path)).length, 5,
    "Chrome 没有恰好发出 5 次筛选当前局租约请求");
  assert.equal(actual.filter(item => /\/slots\/[1-5]\/sessions\/ses_[a-f0-9]{32}\/submissions$/.test(item.path)).length, 5,
    "Chrome 没有恰好发出 5 次筛选专用提交请求");
}

function assertRankedNoFallbackPosts(diagnostics, startIndex) {
  const requests = diagnostics.requests.slice(startIndex).map(entry => ({
    method: entry.method,
    path: pathFromRequestEntry(entry)
  }));
  assert.equal(requests.filter(item => item.method === "POST" && item.path === "/api/v1/sessions").length, 0,
    "筛选流程创建了普通单局 session");
  assert.equal(requests.filter(item => /^\/api\/v1\/sessions\/ses_[a-f0-9]{32}\/submissions$/.test(item.path)).length, 0,
    "筛选流程提交到了普通单局路径");
  assert.equal(requests.filter(item => item.method === "POST"
    && item.path.startsWith("/api/v1/evaluation-batches")).length, 0,
  "筛选流程创建、租用或提交了练习五局");
  assert.equal(requests.filter(item => item.method === "POST"
    && /\/current-slot\/lease$/.test(item.path)
    && !item.path.startsWith(`${RANKED_EVALUATION_PATH}/`)).length, 0,
  "筛选流程领取了非筛选租约");
}

async function runRankedFiveSlotSmoke(page, diagnostics) {
  log("筛选五局烟测：等待本地 Python 与账号筛选状态");
  await waitForPython(page);
  await page.waitForValue(`(() => {
    const panel = document.querySelector("#rankedEvaluationPanel");
    const button = document.querySelector("#startRankedEvaluationButton");
    const status = document.querySelector("#rankedEvaluationStatus")?.textContent?.trim() || "";
    return panel && !button?.hidden && button?.disabled === false && /尚未使用/.test(status) ? status : "";
  })()`, "新账号筛选机会准备完成", { timeoutMs: 30_000 });
  await installRankedFetchProbe(page);
  await resetRankedFetchProbe(page);
  await page.fill("#competitionTeamId", RANKED_SMOKE_TEAM_ID);
  await page.fill("#pythonEditor", RANKED_SMOKE_SOURCE);
  const instrumentationReady = await page.evaluate(`(() => {
    const start = document.querySelector("#startRankedEvaluationButton");
    const confirm = document.querySelector("#confirmRankedEvaluationButton");
    const ordinaryRun = document.querySelector("#runButton");
    if (!start || !confirm || !ordinaryRun) return false;
    globalThis.__chenlongRankedStartClickCount = 0;
    globalThis.__chenlongRankedConfirmClickCount = 0;
    globalThis.__chenlongRankedOrdinaryRunClickCount = 0;
    start.addEventListener("click", () => { globalThis.__chenlongRankedStartClickCount += 1; });
    confirm.addEventListener("click", () => { globalThis.__chenlongRankedConfirmClickCount += 1; });
    ordinaryRun.addEventListener("click", () => { globalThis.__chenlongRankedOrdinaryRunClickCount += 1; });
    return true;
  })()`);
  assert.equal(instrumentationReady, true, "无法记录筛选二次确认点击次数");

  const requestStartIndex = diagnostics.requests.length;
  log("筛选五局烟测：真人点击开始，并在页面二次确认后等待自动串行完成五局");
  await page.click("#startRankedEvaluationButton");
  const confirmation = await page.waitForValue(`(() => {
    const dialog = document.querySelector("#rankedEvaluationConfirmDialog");
    const button = document.querySelector("#confirmRankedEvaluationButton");
    if (!dialog?.open || button?.disabled) return null;
    return {
      title: document.querySelector("#rankedEvaluationConfirmTitle")?.textContent?.trim() || "",
      description: document.querySelector("#rankedEvaluationConfirmDescription")?.textContent?.trim() || "",
      pendingSource: typeof pendingRankedEvaluationConfirmation === "undefined"
        ? null
        : pendingRankedEvaluationConfirmation?.source || null,
      pendingTeamId: typeof pendingRankedEvaluationConfirmation === "undefined"
        ? null
        : pendingRankedEvaluationConfirmation?.teamId || null,
      startClickCount: globalThis.__chenlongRankedStartClickCount,
      confirmClickCount: globalThis.__chenlongRankedConfirmClickCount
    };
  })()`, "筛选唯一机会二次确认对话框", { timeoutMs: 10_000 });
  assert.match(confirmation.title, /唯一一次筛选机会/);
  assert.match(confirmation.description, /源码与队伍立即锁定/);
  assert.match(confirmation.description, /不能.*重新创建第二次/);
  assert.equal(confirmation.pendingSource, RANKED_SMOKE_SOURCE);
  assert.equal(confirmation.pendingTeamId, RANKED_SMOKE_TEAM_ID);
  assert.equal(confirmation.startClickCount, 1, "筛选开始入口不是一次真人点击");
  assert.equal(confirmation.confirmClickCount, 0, "二次确认在真人点击前已被触发");
  assert.deepEqual(await readRankedFetchProbe(page), [], "二次确认前已经占用筛选机会或发出请求");

  await page.click("#confirmRankedEvaluationButton");
  const activeUi = await page.waitForValue(`(() => {
    const active = typeof activeRankedEvaluation === "undefined" ? null : activeRankedEvaluation;
    const editor = document.querySelector("#pythonEditor");
    if (!active || !editor?.readOnly) return null;
    return {
      source: editor.value,
      teamId: document.querySelector("#competitionTeamId")?.value || "",
      teamDisabled: Boolean(document.querySelector("#competitionTeamId")?.disabled),
      startClickCount: globalThis.__chenlongRankedStartClickCount,
      confirmClickCount: globalThis.__chenlongRankedConfirmClickCount,
      ordinaryRunClickCount: globalThis.__chenlongRankedOrdinaryRunClickCount
    };
  })()`, "筛选源码与队伍锁定", { timeoutMs: 30_000 });
  assert.equal(activeUi.source, RANKED_SMOKE_SOURCE);
  assert.equal(activeUi.teamId, RANKED_SMOKE_TEAM_ID);
  assert.equal(activeUi.teamDisabled, true);
  assert.equal(activeUi.startClickCount, 1);
  assert.equal(activeUi.confirmClickCount, 1, "筛选没有经过一次真人二次确认");
  assert.equal(activeUi.ordinaryRunClickCount, 0, "真人误点了普通单局运行按钮");

  const finalState = await page.waitForValue(`(() => {
    const panel = document.querySelector("#rankedEvaluationPanel");
    const status = document.querySelector("#rankedEvaluationStatus")?.textContent?.trim() || "";
    const active = typeof activeRankedEvaluation === "undefined" ? null : activeRankedEvaluation;
    if (panel?.dataset?.state === "error" || active?.uiState === "error") {
      return { error: status || "筛选五局进入错误状态" };
    }
    const batch = active?.batch;
    const operationActive = typeof rankedEvaluationOperation !== "undefined"
      && rankedEvaluationOperation !== null;
    if (panel?.dataset?.state !== "finalized" || batch?.phase !== "finalized"
      || !active?.result || operationActive) return null;
    return {
      phase: batch.phase,
      slots: batch.slots.map(slot => ({
        slotIndex: slot.slotIndex,
        final: slot.final,
        status: slot.status,
        score: slot.score,
        completed: slot.completed
      })),
      summary: structuredClone(batch.summary),
      rank: active.result.rank,
      result: structuredClone(active.result),
      source: active.source,
      teamId: active.teamId,
      createdAt: active.createdAt,
      expiresAt: active.expiresAt,
      anonymousParticipantId: active.anonymousParticipantId,
      editorSource: document.querySelector("#pythonEditor")?.value || "",
      editorReadOnly: Boolean(document.querySelector("#pythonEditor")?.readOnly),
      teamDisabled: Boolean(document.querySelector("#competitionTeamId")?.disabled),
      progressText: document.querySelector("#rankedEvaluationProgress")?.textContent?.trim() || "",
      scoreText: document.querySelector("#rankedEvaluationScore")?.textContent?.trim() || "",
      deadlineText: document.querySelector("#rankedEvaluationDeadline")?.textContent?.trim() || "",
      statusText: status,
      output: document.querySelector("#pythonOutputContent")?.textContent || "",
      startClickCount: globalThis.__chenlongRankedStartClickCount,
      confirmClickCount: globalThis.__chenlongRankedConfirmClickCount,
      ordinaryRunClickCount: globalThis.__chenlongRankedOrdinaryRunClickCount,
      ordinarySubmissionReceipt: typeof latestCompetitionSubmissionReceipt === "undefined"
        ? false
        : Boolean(latestCompetitionSubmissionReceipt)
    };
  })()`, "筛选五局全部经服务端确认并取得名次", {
    timeoutMs: RANKED_SMOKE_TIMEOUT_MS,
    intervalMs: 50,
    accept: value => Boolean(value?.error || value?.phase === "finalized")
  });
  assert.equal(finalState.error, undefined, finalState.error || "筛选五局失败");
  await page.waitForValue(
    `typeof rankedEvaluationOperation !== "undefined" && rankedEvaluationOperation === null`,
    "筛选五局自动串行操作完全结束",
    { timeoutMs: 10_000 }
  );
  const probeEvents = await readRankedFetchProbe(page);
  const traffic = assertRankedMainTraffic(probeEvents, RANKED_SMOKE_SOURCE, RANKED_SMOKE_TEAM_ID);
  assertRankedCdpMainTraffic(diagnostics, requestStartIndex, probeEvents);
  assert.equal(finalState.startClickCount, 1, "筛选主流程不是由且仅由一次开始点击启动");
  assert.equal(finalState.confirmClickCount, 1, "筛选主流程不是由且仅由一次二次确认启动");
  assert.equal(finalState.ordinaryRunClickCount, 0, "筛选自动五局期间点击了普通单局运行按钮");
  assert.equal(finalState.ordinarySubmissionReceipt, false, "筛选自动五局生成了普通单局提交回执");
  assert.equal(finalState.source, RANKED_SMOKE_SOURCE);
  assert.equal(finalState.teamId, RANKED_SMOKE_TEAM_ID);
  assert.equal(finalState.editorSource, RANKED_SMOKE_SOURCE, "筛选五局结束后源码被改写");
  assert.equal(finalState.editorReadOnly, false, "筛选五局结束后编辑器没有解除只读");
  assert.equal(finalState.teamDisabled, false, "筛选五局结束后队伍输入没有解除禁用");
  assert.equal(finalState.rank, 1, "隔离账号最终名次不是第 1 名");
  assert.equal(finalState.result.score.maximum, 100, "筛选最终结果没有使用 100 分制");
  assert.equal(finalState.result.score.value, finalState.summary.batchScore,
    "筛选最终名次分数与页面五局汇总不一致");
  assert.deepEqual(finalState.slots.map(slot => slot.status), Array(5).fill("valid"));
  assert.equal(finalState.progressText, "5 / 5");
  assert.equal(finalState.scoreText, `${finalState.summary.batchScore.toFixed(2)} / 100`);
  assert.notEqual(finalState.deadlineText, "—", "页面没有显示服务器截止时间");
  assert.match(finalState.statusText, /第 1 名/);
  assert.match(finalState.statusText, /\/ 100/);
  assert.match(finalState.output, /browser-e2e-ranked\s+0(?:\.0+)?/,
    "最后一局没有执行锁定的极短源码");
  assert.deepEqual(finalState.summary, traffic.finalized.batch.summary,
    "页面最终汇总与服务端最终 /me 不一致");
  return { finalState, traffic, requestStartIndex };
}

function assertAnonymousRankedRanking(payload, run, credentials) {
  assert.equal(payload?.schemaVersion, "chenlong.ranked-ranking/v1");
  assert.equal(payload?.authoritative, false);
  assert.equal(payload?.scope, "anonymous");
  assert.equal(payload?.competition?.competitionId, RANKED_COMPETITION_ID);
  assert.equal(payload?.competition?.displayName, "筛选五局（本地参考）");
  assert.equal(payload?.pagination?.total, 1);
  assert.equal(payload?.entries?.length, 1);
  const entry = payload.entries[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    "anonymousParticipantId", "quality", "rank", "ranking", "score"
  ], "匿名榜条目字段不符合冻结白名单");
  assert.equal(entry.rank, 1);
  assert.equal(entry.anonymousParticipantId, run.traffic.anonymousParticipantId);
  assert.equal(entry.score.maximum, 100);
  assert.equal(entry.score.value, run.finalState.summary.batchScore);
  assert.equal(entry.quality.validCount, 5);
  assert.equal(entry.quality.missingCount, 0);
  for (const forbiddenKey of [
    "participant", "ownerUserId", "username", "teamId", "lockedTeamId",
    "lockedSource", "sourceCode", "sourceDigest", "batchId", "sessionId", "runId",
    "layout", "layoutCommitment", "runDefinition", "interactionDefinition"
  ]) {
    assert.equal(nestedKeyCount(payload, forbiddenKey), 0, `匿名榜泄露 ${forbiddenKey}`);
  }
  const serialized = JSON.stringify(payload);
  for (const forbiddenValue of [
    RANKED_SMOKE_SOURCE,
    RANKED_SMOKE_TEAM_ID,
    run.traffic.batchId,
    credentials.username,
    credentials.displayName
  ]) {
    assert.equal(serialized.includes(forbiddenValue), false, `匿名榜泄露 ${forbiddenValue}`);
  }
  assertRankedLayoutBoundary(payload, { label: "匿名筛选榜", currentSlotIndex: null });
}

function assertAdminRankedRanking(payload, run, credentials) {
  assert.equal(payload?.schemaVersion, "chenlong.ranked-ranking/v1");
  assert.equal(payload?.authoritative, false);
  assert.equal(payload?.scope, "admin");
  assert.equal(payload?.pagination?.total, 1);
  assert.equal(payload?.entries?.length, 1);
  const entry = payload.entries[0];
  assert.equal(entry.rank, 1);
  assert.equal(entry.anonymousParticipantId, run.traffic.anonymousParticipantId);
  assert.equal(entry.participant?.username, credentials.username);
  assert.equal(entry.participant?.displayName, credentials.displayName);
  assert.equal(entry.participant?.teamName, credentials.teamName);
  assert.match(entry.participant?.id || "", /^usr_[a-f0-9]{32}$/);
  assert.equal(entry.teamId, RANKED_SMOKE_TEAM_ID);
  assert.equal(entry.score.maximum, 100);
  assert.equal(entry.score.value, run.finalState.summary.batchScore);
  for (const forbiddenKey of [
    "lockedSource", "sourceCode", "sourceDigest", "batchId", "sessionId", "runId",
    "layout", "layoutCommitment", "runDefinition", "interactionDefinition"
  ]) {
    assert.equal(nestedKeyCount(payload, forbiddenKey), 0, `管理员榜泄露 ${forbiddenKey}`);
  }
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(RANKED_SMOKE_SOURCE), false, "管理员榜泄露锁定源码");
  assert.equal(serialized.includes(run.traffic.batchId), false, "管理员榜泄露筛选批次编号");
  assertRankedLayoutBoundary(payload, { label: "管理员筛选榜", currentSlotIndex: null });
}

async function testRankedConflictAndRankings(page, run, credentials) {
  log("筛选五局烟测：验证唯一机会冲突、匿名榜和管理员榜边界");
  await resetRankedFetchProbe(page);
  const conflict = await page.evaluate(`fetch(${JSON.stringify(RANKED_EVALUATION_PATH)}, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      source: ${JSON.stringify(RANKED_CONFLICT_SOURCE)},
      teamId: ${JSON.stringify(RANKED_CONFLICT_TEAM_ID)}
    })
  }).then(async response => ({ status: response.status, payload: await response.json() }))`, 30_000);
  assert.equal(conflict.status, 409, "同账号第二份不同源码和队伍没有被拒绝");
  assert.equal(conflict.payload?.error?.code, "RANKED_ATTEMPT_ALREADY_EXISTS");
  const conflictSerialized = JSON.stringify(conflict.payload);
  assert.equal(conflictSerialized.includes(RANKED_SMOKE_SOURCE), false, "唯一机会冲突响应泄露原源码");
  assert.equal(conflictSerialized.includes(RANKED_SMOKE_TEAM_ID), false, "唯一机会冲突响应泄露原队伍");
  assert.doesNotMatch(conflictSerialized, /layoutCommitment|runDefinition|interactionDefinition/,
    "唯一机会冲突响应泄露布局或运行定义");

  const anonymous = await page.evaluate(`fetch(
    ${JSON.stringify(`${RANKED_EVALUATION_PATH}/ranking?offset=0&limit=10`)},
    { credentials: "same-origin", headers: { "Accept": "application/json" } }
  ).then(async response => ({ status: response.status, payload: await response.json() }))`, 30_000);
  assert.equal(anonymous.status, 200, "匿名筛选榜读取失败");
  assertAnonymousRankedRanking(anonymous.payload, run, credentials);

  const admin = await page.evaluate(`fetch(
    ${JSON.stringify(`${ADMIN_RANKED_RANKING_PATH}?offset=0&limit=10`)},
    { credentials: "same-origin", headers: { "Accept": "application/json" } }
  ).then(async response => ({ status: response.status, payload: await response.json() }))`, 30_000);
  assert.equal(admin.status, 200, "管理员筛选榜读取失败");
  assertAdminRankedRanking(admin.payload, run, credentials);

  const pairs = pairBatchProbeEvents(await readRankedFetchProbe(page), "筛选冲突与榜单");
  assert.deepEqual(pairs.map(pair => ({
    method: pair.request.method,
    path: pair.request.path,
    status: pair.response.status
  })), [
    { method: "POST", path: RANKED_EVALUATION_PATH, status: 409 },
    { method: "GET", path: `${RANKED_EVALUATION_PATH}/ranking?offset=0&limit=10`, status: 200 },
    { method: "GET", path: `${ADMIN_RANKED_RANKING_PATH}?offset=0&limit=10`, status: 200 }
  ], "筛选冲突与榜单请求序列不正确");
  assert.deepEqual(parseBatchProbeResponse(pairs[0].response, "筛选唯一机会冲突"), conflict.payload);
  assert.deepEqual(parseBatchProbeResponse(pairs[1].response, "匿名筛选榜"), anonymous.payload);
  assert.deepEqual(parseBatchProbeResponse(pairs[2].response, "管理员筛选榜"), admin.payload);
}

async function testRankedFinalizedReload(page, run) {
  log("筛选五局烟测：完成用户刷新后恢复结果、锁定信息和截止，且不覆盖新草稿、不自动运行");
  await page.fill("#competitionTeamId", RANKED_CONFLICT_TEAM_ID);
  await page.fill("#pythonEditor", RANKED_CONFLICT_SOURCE);
  const poisonedDraft = await page.evaluate(`(() => ({
    editorSource: document.querySelector("#pythonEditor")?.value || "",
    teamId: document.querySelector("#competitionTeamId")?.value || ""
  }))()`);
  assert.deepEqual(poisonedDraft, {
    editorSource: RANKED_CONFLICT_SOURCE,
    teamId: RANKED_CONFLICT_TEAM_ID
  }, "刷新前没有建立与锁定值不同的页面草稿");

  await page.reload(30_000);
  const restored = await page.waitForValue(`(() => {
    const active = typeof activeRankedEvaluation === "undefined" ? null : activeRankedEvaluation;
    const panel = document.querySelector("#rankedEvaluationPanel");
    if (panel?.dataset?.state === "error") {
      return { error: document.querySelector("#rankedEvaluationStatus")?.textContent?.trim() || "恢复失败" };
    }
    if (active?.batch?.phase !== "finalized" || !active?.result) return null;
    return {
      source: active.source,
      teamId: active.teamId,
      expiresAt: active.expiresAt,
      editorSource: document.querySelector("#pythonEditor")?.value || "",
      teamInput: document.querySelector("#competitionTeamId")?.value || "",
      deadlineText: document.querySelector("#rankedEvaluationDeadline")?.textContent?.trim() || "",
      progressText: document.querySelector("#rankedEvaluationProgress")?.textContent?.trim() || "",
      scoreText: document.querySelector("#rankedEvaluationScore")?.textContent?.trim() || "",
      statusText: document.querySelector("#rankedEvaluationStatus")?.textContent?.trim() || "",
      running: typeof running === "undefined" ? false : Boolean(running),
      operationActive: typeof rankedEvaluationOperation === "undefined"
        ? false
        : Boolean(rankedEvaluationOperation),
      latestRecord: typeof latestCompetitionRecord === "undefined"
        ? false
        : Boolean(latestCompetitionRecord)
    };
  })()`, "刷新后从账号恢复筛选结果", {
    timeoutMs: 30_000,
    accept: value => Boolean(value?.error || value?.expiresAt)
  });
  assert.equal(restored.error, undefined, restored.error || "刷新恢复失败");
  assert.equal(restored.source, RANKED_SMOKE_SOURCE, "完成用户刷新后账号状态没有恢复锁定源码");
  assert.equal(restored.teamId, RANKED_SMOKE_TEAM_ID, "完成用户刷新后账号状态没有恢复锁定队伍");
  assert.equal(restored.editorSource, RANKED_CONFLICT_SOURCE, "完成用户刷新意外覆盖了已开始的新源码草稿");
  assert.equal(restored.teamInput, RANKED_CONFLICT_TEAM_ID, "完成用户刷新意外覆盖了新的队伍草稿");
  assert.equal(restored.expiresAt, run.traffic.expiresAt, "刷新后服务器截止时间发生变化");
  assert.equal(restored.deadlineText, run.finalState.deadlineText, "刷新后服务器截止显示没有恢复");
  assert.equal(restored.progressText, "5 / 5");
  assert.equal(restored.scoreText, run.finalState.scoreText);
  assert.match(restored.statusText, /第 1 名/);
  assert.equal(restored.running, false, "刷新后自动运行了 Python");
  assert.equal(restored.operationActive, false, "刷新后自动继续了筛选序列");
  assert.equal(restored.latestRecord, false, "刷新后凭空生成了新的本地运行记录");

  await waitForPython(page);
  await delay(1_000);
  const stable = await page.evaluate(`(() => ({
    running: typeof running === "undefined" ? false : Boolean(running),
    operationActive: typeof rankedEvaluationOperation === "undefined"
      ? false
      : Boolean(rankedEvaluationOperation),
    latestRecord: typeof latestCompetitionRecord === "undefined"
      ? false
      : Boolean(latestCompetitionRecord),
    editorSource: document.querySelector("#pythonEditor")?.value || "",
    deadlineText: document.querySelector("#rankedEvaluationDeadline")?.textContent?.trim() || ""
  }))()`);
  assert.deepEqual(stable, {
    running: false,
    operationActive: false,
    latestRecord: false,
    editorSource: RANKED_CONFLICT_SOURCE,
    deadlineText: run.finalState.deadlineText
  }, "完成用户刷新在 Python 就绪后自动运行、覆盖草稿或改写截止信息");

  const pairs = pairBatchProbeEvents(await readRankedFetchProbe(page), "筛选刷新恢复");
  assert.equal(pairs.length, 1, "完成用户刷新只能读取一次筛选 /me");
  assert.equal(pairs[0].request.method, "GET");
  assert.equal(pairs[0].request.path, `${RANKED_EVALUATION_PATH}/me`);
  assert.equal(pairs[0].response.status, 200);
  const payload = parseBatchProbeResponse(pairs[0].response, "完成用户刷新 /me");
  const evaluation = assertRankedOwnerResponse(payload, {
    label: "完成用户刷新 /me 响应",
    source: RANKED_SMOKE_SOURCE,
    teamId: RANKED_SMOKE_TEAM_ID,
    batchId: run.traffic.batchId,
    createdAt: run.traffic.createdAt,
    expiresAt: run.traffic.expiresAt,
    currentSlotIndex: null
  });
  assert.equal(evaluation.result?.rank, 1);
  assertRankedBatchSummary(evaluation.batch, "完成用户刷新 /me 响应");
  assert.equal(pairs.some(pair => /\/current-slot\/lease$/.test(pair.request.path)), false,
    "刷新恢复自动领取了筛选租约");
  assert.equal(pairs.some(pair => /\/slots\/[1-5]\/sessions\/.+\/submissions$/.test(pair.request.path)), false,
    "刷新恢复自动提交了筛选记录");
}

async function testRankedOpenOwnerRecovery(page, credentials) {
  log("筛选五局烟测：为独立恢复用户创建未租约 open 筛选，清空页面态后验证只恢复不自动运行");
  await resetRankedFetchProbe(page);
  const recoveryCredentials = {
    username: `r${credentials.username}`.slice(0, 30),
    password: `Recovery-${credentials.password}`,
    displayName: "筛选恢复 E2E 用户",
    teamName: "筛选恢复 E2E 队伍",
    group: "primary"
  };
  const registered = await page.evaluate(`fetch("/api/v1/auth/register", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(${JSON.stringify(recoveryCredentials)})
  }).then(async response => ({ status: response.status, payload: await response.json() }))`, 30_000);
  assert.equal(registered.status, 201, "独立恢复用户注册失败");
  assert.equal(registered.payload?.user?.username, recoveryCredentials.username);
  assert.equal(registered.payload?.user?.displayName, recoveryCredentials.displayName);
  assert.equal(registered.payload?.user?.role, "user", "第二个隔离账号不应成为管理员");

  const created = await page.evaluate(`fetch(${JSON.stringify(RANKED_EVALUATION_PATH)}, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      source: ${JSON.stringify(RANKED_RECOVERY_SOURCE)},
      teamId: ${JSON.stringify(RANKED_RECOVERY_TEAM_ID)}
    })
  }).then(async response => ({ status: response.status, payload: await response.json() }))`, 30_000);
  assert.equal(created.status, 201, "独立恢复用户未能创建 open 筛选");
  assert.equal(created.payload?.created, true);
  const createdEvaluation = assertRankedOwnerResponse(created.payload, {
    label: "独立恢复用户创建响应",
    source: RANKED_RECOVERY_SOURCE,
    teamId: RANKED_RECOVERY_TEAM_ID,
    currentSlotIndex: 1
  });
  assert.equal(createdEvaluation.batch.phase, "open");
  assert.equal(createdEvaluation.batch.nextSlotIndex, 1);
  assert.equal(createdEvaluation.result, null);
  const createPairs = pairBatchProbeEvents(await readRankedFetchProbe(page), "独立恢复用户创建");
  assert.equal(createPairs.length, 1, "独立恢复用户创建前后不应请求租约或提交");
  assert.equal(createPairs[0].request.method, "POST");
  assert.equal(createPairs[0].request.path, RANKED_EVALUATION_PATH);
  assert.equal(createPairs[0].response.status, 201);
  assert.equal(createPairs.some(pair => /\/current-slot\/lease$/.test(pair.request.path)), false);
  assert.equal(createPairs.some(pair => /\/slots\/[1-5]\/sessions\/.+\/submissions$/.test(pair.request.path)), false);

  const cleared = await page.evaluate(`(() => {
    sessionStorage.clear();
    return sessionStorage.length;
  })()`);
  assert.equal(cleared, 0, "独立恢复用户页面态没有清空");
  await page.reload(30_000);
  const restored = await page.waitForValue(`(() => {
    const active = typeof activeRankedEvaluation === "undefined" ? null : activeRankedEvaluation;
    const panel = document.querySelector("#rankedEvaluationPanel");
    if (panel?.dataset?.state === "error") {
      return { error: document.querySelector("#rankedEvaluationStatus")?.textContent?.trim() || "恢复失败" };
    }
    if (active?.batch?.phase !== "open" || active?.uiState !== "recovery") return null;
    return {
      source: active.source,
      teamId: active.teamId,
      batchId: active.batch.batchId,
      nextSlotIndex: active.batch.nextSlotIndex,
      createdAt: active.createdAt,
      expiresAt: active.expiresAt,
      editorSource: document.querySelector("#pythonEditor")?.value || "",
      editorReadOnly: Boolean(document.querySelector("#pythonEditor")?.readOnly),
      editorAriaReadOnly: document.querySelector("#pythonEditor")?.getAttribute("aria-readonly") || "",
      teamInput: document.querySelector("#competitionTeamId")?.value || "",
      teamDisabled: Boolean(document.querySelector("#competitionTeamId")?.disabled),
      deadlineText: document.querySelector("#rankedEvaluationDeadline")?.textContent?.trim() || "",
      progressText: document.querySelector("#rankedEvaluationProgress")?.textContent?.trim() || "",
      statusText: document.querySelector("#rankedEvaluationStatus")?.textContent?.trim() || "",
      identityName: document.querySelector("#currentUserName")?.textContent?.trim() || "",
      running: typeof running === "undefined" ? false : Boolean(running),
      operationActive: typeof rankedEvaluationOperation === "undefined"
        ? false
        : Boolean(rankedEvaluationOperation),
      latestRecord: typeof latestCompetitionRecord === "undefined"
        ? false
        : Boolean(latestCompetitionRecord)
    };
  })()`, "独立恢复用户从 /me 恢复 open 筛选", {
    timeoutMs: 30_000,
    accept: value => Boolean(value?.error || value?.expiresAt)
  });
  assert.equal(restored.error, undefined, restored.error || "独立恢复用户恢复失败");
  assert.equal(restored.identityName, recoveryCredentials.teamName, "刷新后没有切换到独立恢复用户");
  assert.equal(restored.source, RANKED_RECOVERY_SOURCE);
  assert.equal(restored.teamId, RANKED_RECOVERY_TEAM_ID);
  assert.equal(restored.batchId, createdEvaluation.batch.batchId);
  assert.equal(restored.nextSlotIndex, 1);
  assert.equal(restored.createdAt, createdEvaluation.createdAt);
  assert.equal(restored.expiresAt, createdEvaluation.expiresAt);
  assert.equal(restored.editorSource, RANKED_RECOVERY_SOURCE, "open 筛选没有恢复锁定源码到编辑器");
  assert.equal(restored.editorReadOnly, true, "open 筛选恢复后编辑器没有只读锁定");
  assert.equal(restored.editorAriaReadOnly, "true", "open 筛选恢复后编辑器无障碍只读状态不正确");
  assert.equal(restored.teamInput, RANKED_RECOVERY_TEAM_ID, "open 筛选没有恢复锁定队伍到输入框");
  assert.equal(restored.teamDisabled, true, "open 筛选恢复后队伍输入没有锁定");
  assert.notEqual(restored.deadlineText, "—", "open 筛选恢复后没有显示服务器截止");
  assert.equal(restored.progressText, "0 / 5");
  assert.match(restored.statusText, /已恢复唯一一次筛选的第 1 \/ 5 局/);
  assert.match(restored.statusText, /不会自动运行/);
  assert.equal(restored.running, false);
  assert.equal(restored.operationActive, false);
  assert.equal(restored.latestRecord, false);

  await page.waitForValue(`(() => {
    const overlay = document.querySelector("#loadingOverlay");
    return typeof pythonReady !== "undefined" && pythonReady
      && (!overlay || overlay.classList.contains("is-hidden"));
  })()`, "独立恢复用户本地 Python 准备完成", { timeoutMs: PYTHON_TIMEOUT_MS, intervalMs: 100 });
  await delay(1_000);
  const stable = await page.evaluate(`(() => ({
    running: typeof running === "undefined" ? false : Boolean(running),
    operationActive: typeof rankedEvaluationOperation === "undefined"
      ? false
      : Boolean(rankedEvaluationOperation),
    latestRecord: typeof latestCompetitionRecord === "undefined"
      ? false
      : Boolean(latestCompetitionRecord),
    editorSource: document.querySelector("#pythonEditor")?.value || "",
    editorReadOnly: Boolean(document.querySelector("#pythonEditor")?.readOnly),
    teamInput: document.querySelector("#competitionTeamId")?.value || "",
    deadlineText: document.querySelector("#rankedEvaluationDeadline")?.textContent?.trim() || ""
  }))()`);
  assert.deepEqual(stable, {
    running: false,
    operationActive: false,
    latestRecord: false,
    editorSource: RANKED_RECOVERY_SOURCE,
    editorReadOnly: true,
    teamInput: RANKED_RECOVERY_TEAM_ID,
    deadlineText: restored.deadlineText
  }, "open 筛选恢复在 Python 就绪后自动运行或解除锁定");

  const recoveryPairs = pairBatchProbeEvents(await readRankedFetchProbe(page), "独立恢复用户刷新");
  assert.equal(recoveryPairs.length, 1, "open 筛选刷新只能读取一次 /me");
  assert.equal(recoveryPairs[0].request.method, "GET");
  assert.equal(recoveryPairs[0].request.path, `${RANKED_EVALUATION_PATH}/me`);
  assert.equal(recoveryPairs[0].response.status, 200);
  const recoveredPayload = parseBatchProbeResponse(recoveryPairs[0].response, "独立恢复用户 /me");
  const recoveredEvaluation = assertRankedOwnerResponse(recoveredPayload, {
    label: "独立恢复用户 /me 响应",
    source: RANKED_RECOVERY_SOURCE,
    teamId: RANKED_RECOVERY_TEAM_ID,
    batchId: createdEvaluation.batch.batchId,
    createdAt: createdEvaluation.createdAt,
    expiresAt: createdEvaluation.expiresAt,
    currentSlotIndex: 1
  });
  assert.equal(recoveredEvaluation.batch.phase, "open");
  assert.equal(recoveredEvaluation.result, null);
  assert.equal(recoveryPairs.some(pair => /\/current-slot\/lease$/.test(pair.request.path)), false,
    "open 筛选刷新自动领取了当前局租约");
  assert.equal(recoveryPairs.some(pair => /\/slots\/[1-5]\/sessions\/.+\/submissions$/.test(pair.request.path)), false,
    "open 筛选刷新自动提交了运行记录");
}

async function runRankedEvaluationSmoke(page, diagnostics, credentials) {
  const main = await runRankedFiveSlotSmoke(page, diagnostics);
  await testRankedConflictAndRankings(page, main, credentials);
  await testRankedFinalizedReload(page, main);
  await testRankedOpenOwnerRecovery(page, credentials);
  assertRankedNoFallbackPosts(diagnostics, main.requestStartIndex);
  const rankedRequests = diagnostics.requests.slice(main.requestStartIndex)
    .map(entry => ({ method: entry.method, path: pathFromRequestEntry(entry) }))
    .filter(entry => entry.path.startsWith(RANKED_EVALUATION_PATH));
  assert.equal(rankedRequests.filter(item => /\/current-slot\/lease$/.test(item.path)).length, 5,
    "完整烟测不是恰好五次筛选租约");
  assert.equal(rankedRequests.filter(item => /\/slots\/[1-5]\/sessions\/ses_[a-f0-9]{32}\/submissions$/.test(item.path)).length, 5,
    "完整烟测不是恰好五次筛选专用提交");
  return main;
}

function guangyangRouteProgram() {
  const route = runGuangyangSafeRoute();
  assert.equal(route.taskState.completed, 8, "浏览器路线生成前未通过 8/8 核心校验");
  assert.equal(route.taskState.finished, true, "浏览器路线生成前核心任务未完成");
  assert.deepEqual(route.collisions, [], "浏览器路线生成前核心校验出现碰撞");
  assert.deepEqual(route.ruleViolations, [], "浏览器路线生成前核心校验出现规则违规");

  const lines = [
    "# browser-e2e Guangyang 8/8 editor preservation sentinel",
    "# 该路线只存在于内部验收脚本，不进入学生示例或浏览器资源。"
  ];
  for (const action of route.actions) {
    if (action.type === "forward") {
      if (action.label === "目标物抓取位") {
        lines.push('print("GY_TARGET_CAMERA_READY")');
      } else if (action.label === "混淆物抓取位") {
        lines.push('print("GY_DISTRACTOR_CAMERA_READY")');
      }
      lines.push(`robot.forward(${action.distanceCm.toFixed(4)})`);
      continue;
    }
    if (action.type === "left_angle" || action.type === "right_angle") {
      lines.push(`robot.${action.type}(${action.degrees.toFixed(6)})`);
      continue;
    }
    assert.ok(["grab", "release"].includes(action.type), `浏览器路线包含未知动作：${action.type}`);
    lines.push(`robot.${action.type}()`);
  }
  return { source: lines.join("\n"), route };
}

async function assertGuangyangCameraDetection(page, outputMarker, category, categoryLabel) {
  await page.waitForValue(
    `document.querySelector("#pythonOutputContent")?.textContent?.includes(${JSON.stringify(outputMarker)}) === true`,
    `${categoryLabel}抓取位就绪`,
    { timeoutMs: 180_000, intervalMs: 40 }
  );
  const evidence = await page.evaluate(`(async () => {
    const frame = await startVirtualCameraVision();
    const status = window.CarVision?.getStatus?.() || null;
    const detections = window.CarVision?.getDetections?.() || [];
    const detection = detections.find(item => item?.category === ${JSON.stringify(category)}) || null;
    const workbench = document.querySelector("#trainingVisionWorkbench");
    return {
      frameId: frame?.frameId ?? null,
      status,
      detection,
      workbenchHidden: Boolean(workbench?.hidden),
      workbenchBoxes: document.querySelectorAll("#trainingVisionOverlay [data-category]").length
    };
  })()`, 30_000);
  assert.equal(evidence.status?.source, "virtual", `${categoryLabel}没有使用正式地图虚拟摄像头`);
  assert.equal(evidence.status?.fresh, true, `${categoryLabel}正式地图摄像头帧已过期`);
  assert.ok(Number.isSafeInteger(evidence.frameId) && evidence.frameId > 0, `${categoryLabel}没有有效摄像头帧号`);
  assert.equal(evidence.detection?.category, category, `${categoryLabel}没有被像素检测器识别`);
  assert.equal(evidence.detection?.source, "virtual-cv", `${categoryLabel}不是由虚拟像素检测器产生`);
  assert.equal(evidence.detection?.frameId, evidence.frameId, `${categoryLabel}检测没有绑定当前帧`);
  assert.equal(evidence.detection?.direction, "中间", `${categoryLabel}抓取位没有在摄像头中央`);
  assert.equal(evidence.detection?.stable, true, `${categoryLabel}检测结果不稳定`);
  assert.ok(Number(evidence.detection?.box?.width) > 0 && Number(evidence.detection?.box?.height) > 0,
    `${categoryLabel}没有有效像素框`);
  for (const forbidden of ["objectId", "packageId", "worldX", "worldZ", "position"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(evidence.detection || {}, forbidden), false,
      `${categoryLabel}像素检测泄露了 ${forbidden}`);
  }
  assert.equal(evidence.workbenchHidden, true, "正式广阳岛不应显示训练摄像头工作台");
  assert.equal(evidence.workbenchBoxes, 0, "正式广阳岛训练工作台残留了检测框");
}

async function runFullGuangyangCompetition(page) {
  log("2/8 运行广阳岛无违规安全路线，并在两类抓取位核对真实像素帧");
  await waitForPython(page);
  await assertTrainingVisionWorkbenchHidden(page, "正式广阳岛场景");
  const generated = guangyangRouteProgram();
  assert.doesNotMatch(generated.source, /robot\.(?:observe|approach|detect|sees|count|near|centered|direction|distance_to)\s*\(/,
    "完整可复算记录不得调用视觉查询 API");
  await page.fill("#pythonEditor", generated.source);
  await page.click("#runButton");
  await page.waitForValue(
    runStateExpression(),
    "广阳岛比赛进入计时运行状态",
    { timeoutMs: 30_000, accept: value => value?.state === "计时运行中" }
  );

  await assertGuangyangCameraDetection(page, "GY_TARGET_CAMERA_READY", "target", "目标物");
  await assertGuangyangCameraDetection(page, "GY_DISTRACTOR_CAMERA_READY", "distractor", "混淆物");

  const completed = await page.waitForValue(`(() => {
    const state = document.querySelector("#competitionRunState")?.textContent?.trim() || "";
    if (state !== "任务完成" && state !== "运行已结束") return null;
    return {
      state,
      delivery: document.querySelector("#missionDeliveryProgress")?.textContent?.trim() || "",
      avoidance: document.querySelector("#missionAvoidanceProgress")?.textContent?.trim() || "",
      avoidanceFailed: document.querySelector("#missionAvoidanceProgress")?.parentElement?.dataset?.failed || "",
      checkpoints: document.querySelector("#missionCheckpointProgress")?.textContent?.trim() || "",
      returned: document.querySelector("#missionReturnProgress")?.textContent?.trim() || "",
      taskScore: document.querySelector("#competitionTaskScore")?.textContent?.trim() || "",
      editorSource: document.querySelector("#pythonEditor")?.value || ""
    };
  })()`, "广阳岛完整任务 8/8", { timeoutMs: 240_000, intervalMs: 100 });
  assert.equal(completed.delivery, "2/2", "两类物体没有全部投放");
  assert.equal(completed.avoidance, "✓", "指定障碍绕行目标没有完成");
  assert.equal(completed.avoidanceFailed, "false", "安全路线错误碰撞了指定障碍");
  assert.equal(completed.checkpoints, "4/4", "四个检查点没有按序完成");
  assert.equal(completed.returned, "✓", "小车没有返航停车区");
  assert.match(completed.taskScore, /^40\.0\s*\/\s*40$/, "完整任务没有获得 40 分任务分");
  assert.equal(completed.editorSource, generated.source, "完整运行结束时编辑器代码被意外改写");
  return { editorSource: generated.source, route: generated.route };
}

async function runTopologyPlannerCompetition(page) {
  log("2/8 运行公开任务锚点 + 图规划 Python 程序");
  await waitForPython(page);
  const plannerPath = path.join(__dirname, "..", "examples", "guangyang_topology_mission_planner.py");
  const source = await fsPromises.readFile(plannerPath, "utf8");
  assert.match(source, /robot\.mission\(\)[\s\S]*robot\.map_graph\(\)[\s\S]*robot\.follow_road\([\s\S]*robot\.take_exit\(/,
    "图规划示例没有使用任务锚点、图和道路控制");
  assert.doesNotMatch(source, /robot\.forward\(1\.\d|robot\.right_angle\(90\.\d/,
    "图规划示例不能是固定验收路线的动作序列");
  await page.fill("#pythonEditor", source);
  await page.click("#runButton");
  await page.waitForValue(
    runStateExpression(),
    "图规划程序进入计时运行状态",
    { timeoutMs: 30_000, accept: value => value?.state === "计时运行中" }
  );
  const completed = await page.waitForValue(`(() => {
    const state = document.querySelector("#competitionRunState")?.textContent?.trim() || "";
    const feedback = document.querySelector("#pythonFeedback");
    const error = !feedback?.hidden ? feedback?.textContent?.trim() || "" : "";
    if (error) return {
      state,
      error,
      output: document.querySelector("#pythonOutputContent")?.textContent || "",
      actionLog: [...document.querySelectorAll("#actionLog .log-text")].slice(-30).map(item => item.textContent || "")
    };
    if (state !== "任务完成") return null;
    return {
      state,
      score: document.querySelector("#competitionScore")?.textContent?.trim() || "",
      delivery: document.querySelector("#missionDeliveryProgress")?.textContent?.trim() || "",
      avoidance: document.querySelector("#missionAvoidanceProgress")?.textContent?.trim() || "",
      checkpoints: document.querySelector("#missionCheckpointProgress")?.textContent?.trim() || "",
      returned: document.querySelector("#missionReturnProgress")?.textContent?.trim() || "",
      output: document.querySelector("#pythonOutputContent")?.textContent || "",
      editorSource: document.querySelector("#pythonEditor")?.value || ""
    };
  })()`, "图规划程序到达终态", { timeoutMs: 240_000, intervalMs: 100 });
  assert.equal(completed.error, undefined,
    `图规划程序异常：${completed.error || "未知错误"}\n${(completed.actionLog || []).join("\n")}`);
  assert.equal(completed.state, "任务完成", `图规划程序未完成：${completed.output}`);
  assert.match(completed.score, /^(?:9[5-9]\.[0-9]|100(?:\.0)?)\b/,
    "图规划程序没有在随机地图达到至少 95.0 分");
  assert.equal(completed.delivery, "2/2", "图规划程序没有完成两类物体处理");
  assert.equal(completed.avoidance, "✓", "图规划程序没有无碰撞绕过障碍物");
  assert.equal(completed.checkpoints, "4/4", "图规划程序没有按序完成四个检查点");
  assert.equal(completed.returned, "✓", "图规划程序没有返回停车区");
  assert.equal(completed.editorSource, source, "图规划运行时编辑器源码被改写");
  return { editorSource: source, route: null };
}

function guangyangRecoveryProgram() {
  const route = runGuangyangRecoveryRoute();
  assert.equal(route.taskState.completed, 7, "浏览器恢复路线生成前未通过 7/8 核心校验");
  assert.equal(route.taskState.finished, false, "浏览器恢复路线不应被核心判为任务完成");
  assert.deepEqual(route.taskState.avoidanceProgress.failedObjectIds, ["guangyang-obstacle-1"],
    "浏览器恢复路线没有只标记指定障碍失败");
  assert.deepEqual(route.collisions.map(item => item.colliderId), ["object:guangyang-obstacle-1"],
    "浏览器恢复路线没有且仅有一次指定障碍碰撞");
  assert.deepEqual(route.ruleViolations.filter(item => item.type !== "collision"), [],
    "浏览器恢复路线出现了碰撞以外的违规");

  const lines = [
    "# browser-e2e Guangyang 7/8 collision recovery sentinel",
    "# 内部负向验收：只碰撞指定障碍，随后恢复路线完成其余七个单元。"
  ];
  for (const action of route.actions) {
    if (action.type === "forward") {
      lines.push(`robot.forward(${action.distanceCm.toFixed(4)})`);
      continue;
    }
    if (action.type === "left_angle" || action.type === "right_angle") {
      lines.push(`robot.${action.type}(${action.degrees.toFixed(6)})`);
      continue;
    }
    assert.ok(["grab", "release"].includes(action.type), `浏览器恢复路线包含未知动作：${action.type}`);
    lines.push(`robot.${action.type}()`);
  }
  return { source: lines.join("\n"), route };
}

function recoveryMissionStateExpression() {
  return `(() => {
    const avoidance = document.querySelector("#missionAvoidanceProgress");
    return {
      runState: document.querySelector("#competitionRunState")?.textContent?.trim() || "",
      missionValue: document.querySelector("#missionProgressValue")?.textContent?.trim() || "",
      missionHint: document.querySelector("#missionProgressHint")?.textContent?.trim() || "",
      missionBar: document.querySelector("#missionProgressBar")?.style?.width || "",
      delivery: document.querySelector("#missionDeliveryProgress")?.textContent?.trim() || "",
      avoidance: avoidance?.textContent?.trim() || "",
      avoidanceFailed: avoidance?.parentElement?.dataset?.failed || "",
      avoidanceComplete: avoidance?.parentElement?.dataset?.complete || "",
      checkpoints: document.querySelector("#missionCheckpointProgress")?.textContent?.trim() || "",
      returned: document.querySelector("#missionReturnProgress")?.textContent?.trim() || "",
      taskScore: document.querySelector("#competitionTaskScore")?.textContent?.trim() || "",
      ruleScore: document.querySelector("#competitionRuleScore")?.textContent?.trim() || "",
      autoScore: document.querySelector("#competitionAutoScore")?.textContent?.trim() || "",
      totalScore: document.querySelector("#competitionScore")?.textContent?.trim() || "",
      editorSource: document.querySelector("#pythonEditor")?.value || ""
    };
  })()`;
}

function assertRecoveryMissionState(state, label) {
  assert.equal(state.missionValue, "7/8", `${label}的综合任务进度不是 7/8`);
  assert.match(state.missionHint, /障碍绕行失败|碰撞.*指定障碍/, `${label}没有说明指定障碍失败`);
  assert.equal(state.missionBar, "88%", `${label}的任务进度条没有停在 7/8`);
  assert.equal(state.delivery, "2/2", `${label}的两类投放没有完成`);
  assert.equal(state.avoidance, "失败", `${label}没有重建绕障失败文本`);
  assert.equal(state.avoidanceFailed, "true", `${label}没有重建绕障 data-failed=true`);
  assert.equal(state.avoidanceComplete, "false", `${label}错误地把绕障标记为完成`);
  assert.equal(state.checkpoints, "4/4", `${label}的四个检查点没有完成`);
  assert.equal(state.returned, "✓", `${label}的返航目标没有完成`);
  assert.match(state.taskScore, /^35\.0\s*\/\s*40$/, `${label}的 7/8 任务分不正确`);
  assert.match(state.ruleScore, /^23\.3\s*\/\s*25$/, `${label}没有扣除一次碰撞规则分`);
  assert.match(state.autoScore, /^15\.0\s*\/\s*15$/, `${label}不应扣自主控制分`);
  assert.equal(state.totalScore, "73.3", `${label}总分不正确`);
}

async function runGuangyangRecoveryCompetition(page) {
  log("2/10 运行广阳岛指定障碍碰撞恢复路线，验证其余七个单元完成");
  await waitForPython(page);
  await assertTrainingVisionWorkbenchHidden(page, "正式广阳岛恢复场景");
  const generated = guangyangRecoveryProgram();
  assert.doesNotMatch(generated.source, /robot\.(?:observe|approach|detect|sees|count|near|centered|direction|distance_to)\s*\(/,
    "恢复记录不得调用视觉查询 API");
  await page.fill("#pythonEditor", generated.source);
  await page.click("#runButton");
  await page.waitForValue(
    runStateExpression(),
    "广阳岛恢复比赛进入计时运行状态",
    { timeoutMs: 30_000, accept: value => value?.state === "计时运行中" }
  );

  const finished = await page.waitForValue(
    recoveryMissionStateExpression(),
    "广阳岛恢复路线完成 7/8",
    {
      timeoutMs: 300_000,
      intervalMs: 100,
      accept: value => value?.runState === "运行已结束" && value?.missionValue === "7/8"
    }
  );
  assertRecoveryMissionState(finished, "真实运行 DOM");
  assert.equal(finished.runState, "运行已结束", "失败路线不应显示任务完成");
  assert.equal(finished.editorSource, generated.source, "恢复运行结束时编辑器代码被意外改写");
  return { editorSource: generated.source, route: generated.route };
}

const STUDENT_OBSERVATION_KEYS = [
  "category",
  "categoryLabel",
  "confidence",
  "direction",
  "distanceCm",
  "label",
  "name",
  "near",
  "stable"
];

const TRAINING_VISION_SCENE_IDS = Object.freeze({
  target: "target-delivery",
  obstacle: "obstacle-avoidance",
  distractor: "distractor-removal"
});

const GUANGYANG_FORMAL_OBJECT_IDS = Object.freeze([
  "guangyang-distractor-1",
  "guangyang-obstacle-1",
  "guangyang-target-1"
]);

const TRAINING_VISION_CATEGORY_LABELS = Object.freeze({
  target: "目标物",
  obstacle: "障碍物",
  distractor: "混淆物",
  "storage-zone": "存放点",
  "cleanup-zone": "清理点"
});

function trainingObservationSource(categoryLabel, marker) {
  return [
    `observations = robot.observe(${JSON.stringify(categoryLabel)})`,
    `print(${JSON.stringify(`${marker}_COUNT`)}, len(observations))`,
    "if observations:",
    `    print(${JSON.stringify(`${marker}_KEYS`)}, ",".join(sorted(observations[0].keys())))`,
    `    print(${JSON.stringify(`${marker}_DISTANCE`)}, observations[0]["distanceCm"])`
  ];
}

async function captureFormalGuangyangIdentity(page) {
  const trainingActive = await page.evaluate(`Boolean(
    typeof activeMission !== "undefined"
    && activeMission?.trainingOnGuangyang === true
  )`);
  if (trainingActive) await page.click("#guangyangTrainingButton");
  await page.select("#sceneSelect", "guangyang");
  const identity = await page.waitForValue(`(() => {
    if (document.querySelector("#sceneSelect")?.value !== "guangyang"
      || typeof activeMission === "undefined"
      || activeMission?.environment !== "guangyang"
      || activeMission?.trainingOnGuangyang === true
      || !activeMission?.competition?.config?.mapId) return null;
    return {
      mapId: activeMission.competition.config.mapId,
      objectIds: [
        ...(activeMission.packages || []).map(item => item?.id),
        ...(activeMission.objectObstacles || []).map(item => item?.id)
      ].filter(Boolean).sort(),
      submissionId: latestCompetitionSubmissionReceipt?.submissionId || "",
      submissionRunId: latestCompetitionSubmissionReceipt?.recordRef?.runId || "",
      latestRecordRunId: latestCompetitionRecord?.runId || "",
      hudVisible: !document.querySelector("#competitionHud")?.hidden,
      workbenchHidden: Boolean(document.querySelector("#trainingVisionWorkbench")?.hidden)
    };
  })()`, "广阳岛正式地图身份就绪", { timeoutMs: 15_000 });
  assert.deepEqual(identity.objectIds, [...GUANGYANG_FORMAL_OBJECT_IDS],
    "广阳岛正式地图三类物体 ID 与冻结定义不一致");
  assert.equal(identity.hudVisible, true, "正式广阳岛没有显示比赛 HUD");
  assert.equal(identity.workbenchHidden, true, "正式广阳岛不应显示训练视觉台");
  return identity;
}

async function selectTrainingScene(page, trainingMode, expectedTitle, formalIdentity) {
  const alreadyTraining = await page.evaluate(`Boolean(
    typeof activeMission !== "undefined"
    && activeMission?.trainingOnGuangyang === true
  )`);
  if (await page.evaluate(`document.querySelector("#sceneSelect")?.value`) !== "guangyang") {
    await page.select("#sceneSelect", "guangyang");
  }
  if (!alreadyTraining) {
    await page.click("#guangyangTrainingButton");
    await page.waitForValue(`typeof activeMission !== "undefined"
      && activeMission?.environment === "guangyang"
      && activeMission?.trainingOnGuangyang === true`, "进入广阳岛摄像头训练");
  }
  const trainingModeSelector = `[data-guangyang-training="${trainingMode}"]`;
  await page.waitForValue(`(() => {
    const element = document.querySelector(${JSON.stringify(`[data-guangyang-training="${trainingMode}"]`)});
    const card = document.querySelector("#missionCard");
    if (!element || !card) return false;
    const animations = typeof card.getAnimations === "function" ? card.getAnimations({ subtree: true }) : [];
    if (animations.some(animation => animation.playState === "running" || animation.playState === "pending")) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(top && (top === element || element.contains(top)));
  })()`, `训练类别“${trainingMode}”完成展开并可点击`, { timeoutMs: 5_000, intervalMs: 20 });
  await page.click(trainingModeSelector);
  const state = await page.waitForValue(`(() => {
    const select = document.querySelector("#sceneSelect");
    const title = document.querySelector("#missionTitle")?.textContent?.trim() || "";
    const panel = document.querySelector("#objectTrainingPanel");
    const workbench = document.querySelector("#trainingVisionWorkbench");
    const progress = document.querySelector("#missionProgressValue")?.textContent?.trim() || "";
    const flatMapAvailable = typeof guangyangFlatMapPlane !== "undefined"
      && Boolean(guangyangFlatMapPlane?.parent && guangyangFlatMapPlane?.geometry && guangyangFlatMapPlane?.material);
    const reliefAvailable = typeof guangyangReliefRoot !== "undefined"
      && Boolean(guangyangReliefRoot?.parent && guangyangReliefRoot?.children?.length);
    if (select?.value !== "guangyang" || title !== ${JSON.stringify(expectedTitle)}
      || panel?.hidden || workbench?.hidden || !flatMapAvailable || !reliefAvailable) {
      return null;
    }
    const canvas = document.querySelector("#trainingVisionCanvas");
    return {
      title,
      progress,
      panelVisible: true,
      workbenchStatus: workbench.dataset.status || "",
      workbenchFrameId: workbench.dataset.frameId || "",
      workbenchSceneId: workbench.dataset.sceneId || "",
      environment: activeMission?.environment || "",
      trainingOnGuangyang: activeMission?.trainingOnGuangyang === true,
      trainingMode: activeMission?.objectTraining?.mode || "",
      mapId: activeMission?.guangyangSceneConfig?.mapId || "",
      mapWidth: typeof currentMapWidth === "function" ? currentMapWidth() : null,
      mapDepth: typeof currentMapDepth === "function" ? currentMapDepth() : null,
      cameraMode: typeof cameraMode === "string" ? cameraMode : "",
      flatMapAvailable,
      reliefAvailable,
      reliefVisible: Boolean(guangyangReliefRoot?.visible),
      objectIds: [
        ...(activeMission?.packages || []).map(item => item?.id),
        ...(activeMission?.objectObstacles || []).map(item => item?.id)
      ].filter(Boolean).sort(),
      hasCompetition: Boolean(activeMission?.competition),
      competitionSessionAbsent: typeof competitionSession === "undefined" || competitionSession === null,
      serverSessionAbsent: typeof activeCompetitionServerSession === "undefined" || activeCompetitionServerSession === null,
      submissionId: latestCompetitionSubmissionReceipt?.submissionId || "",
      submissionRunId: latestCompetitionSubmissionReceipt?.recordRef?.runId || "",
      latestRecordRunId: latestCompetitionRecord?.runId || "",
      hudHidden: Boolean(document.querySelector("#competitionHud")?.hidden),
      trainingButtonPressed: document.querySelector("#guangyangTrainingButton")?.getAttribute("aria-pressed") === "true",
      modeButtonPressed: document.querySelector(${JSON.stringify(`[data-guangyang-training="${trainingMode}"]`)})?.getAttribute("aria-pressed") === "true",
      canvasWidth: canvas?.width || 0,
      canvasHeight: canvas?.height || 0,
      boxCount: document.querySelectorAll("#trainingVisionOverlay [data-vision-box]").length,
      emptyVisible: !document.querySelector("#trainingVisionEmpty")?.hidden,
      carVisionFrameId: window.CarVision?.getStatus?.().frameId ?? null
    };
  })()`, `训练场景“${expectedTitle}”加载完成`, { timeoutMs: 15_000 });
  assert.equal(state.title, expectedTitle);
  assert.equal(state.panelVisible, true);
  assert.equal(state.environment, "guangyang", `${expectedTitle}没有保留广阳岛环境`);
  assert.equal(state.trainingOnGuangyang, true, `${expectedTitle}没有标记为广阳岛同图训练`);
  assert.equal(state.trainingMode, trainingMode, `${expectedTitle}训练模式不正确`);
  assert.equal(state.mapId, formalIdentity.mapId, `${expectedTitle}没有使用正式比赛同一 mapId`);
  assert.equal(state.mapWidth, 40, `${expectedTitle}没有使用广阳岛 40 单位地图宽度`);
  assert.equal(state.mapDepth, 24, `${expectedTitle}没有使用广阳岛 24 单位地图深度`);
  assert.equal(state.flatMapAvailable, true, `${expectedTitle}没有构建可用的广阳岛底图平面`);
  assert.equal(state.reliefAvailable, true, `${expectedTitle}没有构建广阳岛立体地形`);
  assert.equal(state.cameraMode, "iso", `${expectedTitle}没有保持广阳岛斜视模式`);
  assert.equal(state.reliefVisible, true, `${expectedTitle}在斜视模式下没有显示广阳岛立体地形`);
  assert.deepEqual(state.objectIds, formalIdentity.objectIds, `${expectedTitle}更换了正式地图三类物体 ID`);
  assert.equal(state.hasCompetition, false, `${expectedTitle}不应携带比赛配置`);
  assert.equal(state.competitionSessionAbsent, true, `${expectedTitle}不应创建 CompetitionSession`);
  assert.equal(state.serverSessionAbsent, true, `${expectedTitle}不应持有服务端比赛 session`);
  assert.equal(state.submissionId, formalIdentity.submissionId, `${expectedTitle}改变了进入训练前的 submission`);
  assert.equal(state.submissionRunId, formalIdentity.submissionRunId, `${expectedTitle}改变了 submission 对应 runId`);
  assert.equal(state.latestRecordRunId, formalIdentity.latestRecordRunId, `${expectedTitle}改变了已归档正式记录`);
  assert.equal(state.hudHidden, true, `${expectedTitle}不应显示比赛 HUD`);
  assert.equal(state.trainingButtonPressed, true, `${expectedTitle}训练总开关状态不正确`);
  assert.equal(state.modeButtonPressed, true, `${expectedTitle}训练类别按钮状态不正确`);
  assert.equal(state.workbenchStatus, "empty", `${expectedTitle}切入时视觉台没有进入等待状态`);
  assert.equal(state.workbenchFrameId, "", `${expectedTitle}切入时残留了上一场景的帧号`);
  assert.equal(state.workbenchSceneId, TRAINING_VISION_SCENE_IDS[trainingMode],
    `${expectedTitle}视觉台绑定了错误训练场景`);
  assert.equal(state.boxCount, 0, `${expectedTitle}切入时残留了上一场景的检测框`);
  assert.equal(state.emptyVisible, true, `${expectedTitle}切入时没有显示等待画面`);
  assert.ok(state.canvasWidth >= 640 && state.canvasHeight >= 480,
    `${expectedTitle}摄像头画布像素尺寸不足`);
  assertNear(state.canvasWidth / state.canvasHeight, 4 / 3, 0.001,
    `${expectedTitle}摄像头画布比例不正确`);
  return state;
}

async function assertTrainingVisionWorkbenchHidden(page, label) {
  const state = await page.evaluate(`(() => {
    const workbench = document.querySelector("#trainingVisionWorkbench");
    if (!workbench) return { found: false };
    const style = getComputedStyle(workbench);
    return {
      found: true,
      hidden: Boolean(workbench.hidden || style.display === "none" || style.visibility === "hidden"),
      status: workbench.dataset.status || "",
      frameId: workbench.dataset.frameId || "",
      sceneId: workbench.dataset.sceneId || "",
      boxCount: document.querySelectorAll("#trainingVisionOverlay [data-vision-box]").length
    };
  })()`);
  assert.equal(state.found, true, "页面缺少训练摄像头视觉台");
  assert.equal(state.hidden, true, `${label}不应显示训练摄像头视觉台`);
  assert.equal(state.frameId, "", `${label}隐藏视觉台时仍保留旧帧号`);
  assert.equal(state.boxCount, 0, `${label}隐藏视觉台时仍保留旧检测框`);
}

function sourceBoxFromModelBox(box, sourceWidth, sourceHeight) {
  const modelSize = 640;
  const scale = Math.min(modelSize / sourceWidth, modelSize / sourceHeight);
  const drawWidth = Math.round(sourceWidth * scale);
  const drawHeight = Math.round(sourceHeight * scale);
  const padX = Math.floor((modelSize - drawWidth) / 2);
  const padY = Math.floor((modelSize - drawHeight) / 2);
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const left = clamp((Number(box.x) - padX) / scale, 0, sourceWidth);
  const top = clamp((Number(box.y) - padY) / scale, 0, sourceHeight);
  const right = clamp((Number(box.x) + Number(box.width) - padX) / scale, 0, sourceWidth);
  const bottom = clamp((Number(box.y) + Number(box.height) - padY) / scale, 0, sourceHeight);
  return {
    left: left / sourceWidth,
    top: top / sourceHeight,
    width: Math.max(0, right - left) / sourceWidth,
    height: Math.max(0, bottom - top) / sourceHeight
  };
}

function assertNear(actual, expected, tolerance, message) {
  assert.ok(Number.isFinite(actual), `${message}（实际值不是有效数字）`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}（期望 ${expected.toFixed(4)}，实际 ${actual.toFixed(4)}）`);
}

async function assertTrainingVisionWorkbenchFrame(page, {
  category,
  categoryLabel,
  previousFrameId
}) {
  const state = await page.waitForValue(`(() => {
    const workbench = document.querySelector("#trainingVisionWorkbench");
    const canvas = document.querySelector("#trainingVisionCanvas");
    const context = canvas?.getContext?.("2d", { willReadFrequently: true });
    const status = window.CarVision?.getStatus?.() || null;
    if (!workbench || workbench.hidden || workbench.dataset.status !== "ready"
      || !canvas || !context || !status?.fresh) return null;
    const frameId = Number(workbench.dataset.frameId);
    if (!Number.isSafeInteger(frameId) || frameId !== status.frameId) return null;

    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    let lit = 0;
    let minimum = 255;
    let maximum = 0;
    const colors = new Set();
    for (let offset = 0; offset < pixels.length; offset += 16) {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (alpha > 0) opaque += 1;
      if (red + green + blue > 30) lit += 1;
      minimum = Math.min(minimum, red, green, blue);
      maximum = Math.max(maximum, red, green, blue);
      colors.add([red >> 4, green >> 4, blue >> 4].join(":"));
    }
    const sampleCount = pixels.length / 16;
    const canvasRect = canvas.getBoundingClientRect();
    const detections = (window.CarVision?.getDetections?.() || [])
      .filter(item => item?.box && Number(item.box.width) > 0 && Number(item.box.height) > 0)
      .map(item => ({
        category: item.category,
        label: item.label,
        frameId: item.frameId,
        box: item.box
      }));
    const boxes = [...document.querySelectorAll("#trainingVisionOverlay [data-vision-box]")].map(element => {
      const rect = element.getBoundingClientRect();
      return {
        category: element.dataset.category || "",
        frameId: Number(element.dataset.frameId),
        text: element.textContent?.trim() || "",
        left: (rect.left - canvasRect.left) / canvasRect.width,
        top: (rect.top - canvasRect.top) / canvasRect.height,
        width: rect.width / canvasRect.width,
        height: rect.height / canvasRect.height
      };
    });
    let rendererState = null;
    if (typeof renderer !== "undefined" && renderer && typeof THREE !== "undefined") {
      const viewport = renderer.getViewport(new THREE.Vector4());
      const logicalSize = renderer.getSize(new THREE.Vector2());
      const drawingBuffer = renderer.getDrawingBufferSize(new THREE.Vector2());
      const simulationCanvas = document.querySelector("#simCanvas");
      rendererState = {
        defaultTarget: renderer.getRenderTarget() === null,
        scissorTest: renderer.getScissorTest(),
        viewport: { x: viewport.x, y: viewport.y, width: viewport.z, height: viewport.w },
        logicalSize: { width: logicalSize.x, height: logicalSize.y },
        drawingBuffer: { width: drawingBuffer.x, height: drawingBuffer.y },
        canvas: { width: simulationCanvas?.width || 0, height: simulationCanvas?.height || 0 }
      };
    }
    return {
      root: {
        status: workbench.dataset.status || "",
        frameId,
        sceneId: workbench.dataset.sceneId || ""
      },
      status,
      frameLabel: document.querySelector("#trainingVisionFrameLabel")?.textContent?.trim() || "",
      statusText: document.querySelector("#trainingVisionStatus")?.textContent?.trim() || "",
      canvas: {
        width: canvas.width,
        height: canvas.height,
        cssWidth: canvasRect.width,
        cssHeight: canvasRect.height,
        opaqueRatio: opaque / sampleCount,
        litRatio: lit / sampleCount,
        colorCount: colors.size,
        channelRange: maximum - minimum
      },
      rendererState,
      detections,
      boxes
    };
  })()`, `${categoryLabel}摄像头训练台刷新`, {
    timeoutMs: 20_000,
    intervalMs: 25,
    accept: value => Boolean(value?.detections?.some(item => item.category === category))
  });

  assert.ok(state.root.frameId > Number(previousFrameId ?? -1), `${categoryLabel}摄像头帧号没有增长`);
  assert.equal(state.status.frameId, state.root.frameId, `${categoryLabel}视觉台帧号与 CarVision 不一致`);
  assert.match(state.frameLabel, new RegExp(`(?:^|\\D)${state.root.frameId}(?:\\D|$)`),
    `${categoryLabel}视觉台没有显示当前帧号`);
  assert.match(state.statusText, /像素识别已标出\s*\d+\s*个训练对象/,
    `${categoryLabel}视觉台状态没有显示识别数量`);
  assert.ok(state.canvas.width >= 640 && state.canvas.height >= 480, `${categoryLabel}画面像素尺寸不足`);
  assertNear(state.canvas.width / state.canvas.height, 4 / 3, 0.001, `${categoryLabel}画面比例不正确`);
  assert.ok(state.canvas.cssWidth > 0 && state.canvas.cssHeight > 0, `${categoryLabel}画面没有可见尺寸`);
  assert.ok(state.canvas.opaqueRatio > 0.98, `${categoryLabel}画面大面积透明`);
  assert.ok(state.canvas.litRatio > 0.05, `${categoryLabel}画面像素为空或近乎全黑`);
  assert.ok(state.canvas.colorCount >= 12, `${categoryLabel}画面缺少真实场景颜色变化`);
  assert.ok(state.canvas.channelRange >= 40, `${categoryLabel}画面缺少真实场景明暗变化`);
  assert.equal(state.rendererState?.defaultTarget, true, `${categoryLabel}抓帧后没有恢复主渲染目标`);
  assert.equal(state.rendererState?.scissorTest, false, `${categoryLabel}抓帧后主渲染器仍启用了裁剪测试`);
  assert.ok(state.rendererState?.viewport?.width > 0 && state.rendererState?.viewport?.height > 0,
    `${categoryLabel}抓帧后主渲染视口无效`);
  assert.deepEqual(state.rendererState?.viewport, {
    x: 0,
    y: 0,
    width: state.rendererState.logicalSize.width,
    height: state.rendererState.logicalSize.height
  }, `${categoryLabel}抓帧后主渲染视口没有恢复到完整画布`);
  assert.deepEqual(state.rendererState?.canvas, state.rendererState?.drawingBuffer,
    `${categoryLabel}主渲染器绘图缓冲与画布尺寸不一致`);

  const expectedDetections = state.detections
    .filter(item => item.frameId === state.root.frameId)
    .sort((left, right) => String(left.category).localeCompare(String(right.category)) || left.box.x - right.box.x);
  const renderedBoxes = [...state.boxes]
    .sort((left, right) => String(left.category).localeCompare(String(right.category)) || left.left - right.left);
  assert.equal(renderedBoxes.length, expectedDetections.length,
    `${categoryLabel}视觉台检测框数量与 CarVision 不一致`);
  expectedDetections.forEach((detection, index) => {
    const rendered = renderedBoxes[index];
    assert.equal(rendered.category, detection.category, `${categoryLabel}检测框类别与 CarVision 不一致`);
    assert.equal(rendered.frameId, detection.frameId, `${categoryLabel}检测框绑定了错误帧`);
    const displayLabel = TRAINING_VISION_CATEGORY_LABELS[detection.category] || detection.label;
    assert.ok(rendered.text.includes(displayLabel), `${categoryLabel}检测框未显示 CarVision 类别名称`);
    const expected = sourceBoxFromModelBox(detection.box, state.canvas.width, state.canvas.height);
    assertNear(rendered.left, expected.left, 0.015, `${categoryLabel}检测框左边界映射错误`);
    assertNear(rendered.top, expected.top, 0.02, `${categoryLabel}检测框上边界映射错误`);
    assertNear(rendered.width, expected.width, 0.02, `${categoryLabel}检测框宽度映射错误`);
    assertNear(rendered.height, expected.height, 0.025, `${categoryLabel}检测框高度映射错误`);
    assert.ok(rendered.left >= -0.001 && rendered.top >= -0.001
      && rendered.left + rendered.width <= 1.001 && rendered.top + rendered.height <= 1.001,
    `${categoryLabel}检测框超出摄像头画面`);
  });
  return state;
}

async function startTrainingProgram(page, source) {
  await page.fill("#pythonEditor", source);
  await page.click("#runButton");
  await page.waitForValue(`(() => {
    const rows = [...document.querySelectorAll("#actionLog .log-text")].map(row => row.textContent || "");
    return rows.some(text => text.includes("从当前位置开始运行 Python 程序"));
  })()`, "训练程序开始运行", { timeoutMs: 10_000, intervalMs: 20 });
}

async function assertVirtualPixelObservation(page, {
  marker,
  category,
  categoryLabel,
  previousFrameId
}) {
  const output = await page.waitForValue(`(() => {
    const text = document.querySelector("#pythonOutputContent")?.textContent || "";
    return text.includes(${JSON.stringify(`${marker}_KEYS`)})
      || text.includes(${JSON.stringify(`${marker}_DONE`)}) ? text : "";
  })()`, `${categoryLabel}观察结果输出`, { timeoutMs: 20_000, intervalMs: 25 });
  assert.match(output, new RegExp(`${marker}_COUNT\\s+[1-9]\\d*`), `${categoryLabel}没有返回像素识别结果`);
  const keyMatch = output.match(new RegExp(`${marker}_KEYS\\s+([^\\r\\n]+)`));
  assert.ok(keyMatch, `${categoryLabel}观察结果没有输出字段列表`);
  assert.deepEqual(
    keyMatch[1].trim().split(","),
    STUDENT_OBSERVATION_KEYS,
    `${categoryLabel}观察 API 泄露了坐标或缺少安全字段`
  );

  const evidence = await page.evaluate(`(() => {
    const status = window.CarVision?.getStatus?.() || null;
    const detection = (window.CarVision?.getDetections?.() || [])
      .find(item => item.category === ${JSON.stringify(category)}) || null;
    const observationRows = [...document.querySelectorAll("#objectTrainingObservations li")]
      .map(item => item.textContent?.trim() || "");
    return {
      status,
      detection: detection ? {
        category: detection.category,
        source: detection.source,
        detectorVersion: detection.detectorVersion,
        frameId: detection.frameId,
        direction: detection.direction,
        distance: detection.distance,
        box: detection.box,
        keys: Object.keys(detection).sort()
      } : null,
      observationRows
    };
  })()`);
  assert.equal(evidence.status?.source, "virtual", `${categoryLabel}查询没有使用虚拟摄像头帧`);
  assert.equal(evidence.status?.fresh, true, `${categoryLabel}查询关联的虚拟摄像头帧已过期`);
  assert.equal(evidence.status?.detectorVersion, "chenlong.virtual-pixel/v2");
  assert.ok(Number.isSafeInteger(evidence.status?.frameId) && evidence.status.frameId > 0,
    `${categoryLabel}查询没有有效摄像头帧编号`);
  assert.equal(evidence.detection?.category, category);
  assert.equal(evidence.detection?.source, "virtual-cv", `${categoryLabel}不是由像素检测器产生`);
  assert.equal(evidence.detection?.detectorVersion, "chenlong.virtual-pixel/v2");
  assert.equal(evidence.detection?.frameId, evidence.status.frameId, `${categoryLabel}检测结果没有绑定当前像素帧`);
  if (category === "target") {
    assert.equal(evidence.detection?.direction, "中间", "正前方目标物被虚拟摄像头错误判断为偏左或偏右");
    assert.ok(Number(evidence.detection?.distance) > 0 && Number(evidence.detection?.distance) < 3,
      "广阳岛同图目标物没有返回合理的正向像素距离");
  }
  assert.ok(Number(evidence.detection?.box?.width) > 0 && Number(evidence.detection?.box?.height) > 0,
    `${categoryLabel}检测结果缺少像素包围框`);
  for (const forbidden of ["x", "z", "position", "worldX", "worldZ", "objectId"]) {
    assert.equal(evidence.detection?.keys?.includes(forbidden), false, `${categoryLabel}检测结果意外包含 ${forbidden}`);
  }
  assert.ok(
    evidence.observationRows.some(row => row.includes(categoryLabel) && /\d+ cm/.test(row)),
    `${categoryLabel}没有显示在训练面板的摄像头观察列表中`
  );
  const workbench = await assertTrainingVisionWorkbenchFrame(page, {
    category,
    categoryLabel,
    previousFrameId
  });
  return { output, frameId: workbench.root.frameId };
}

async function waitForTrainingProgramFinished(page, sentinel, timeoutMs = 45_000) {
  const result = await page.waitForValue(`(() => {
    const output = document.querySelector("#pythonOutputContent")?.textContent || "";
    const feedback = document.querySelector("#pythonFeedback");
    const feedbackText = feedback?.textContent?.trim() || "";
    const rows = [...document.querySelectorAll("#actionLog .log-text")].map(row => row.textContent || "");
    const finished = rows.some(text => text.includes("Python 程序执行完成"));
    if (!feedback?.hidden && feedbackText) return { error: feedbackText, output, rows };
    if (!output.includes(${JSON.stringify(sentinel)}) || !finished) return null;
    return {
      output,
      rows,
      progressLabel: document.querySelector("#missionProgressLabel")?.textContent?.trim() || "",
      progressValue: document.querySelector("#missionProgressValue")?.textContent?.trim() || "",
      complete: document.querySelector("#missionCard")?.classList.contains("is-complete") || false,
      checklist: [...document.querySelectorAll("#objectTrainingChecklist li")].map(item => ({
        text: item.textContent?.trim() || "",
        complete: item.dataset.complete === "true"
      })),
      coachState: document.querySelector("#objectTrainingCoach")?.dataset?.state || "",
      coachMessage: document.querySelector("#objectTrainingCoachMessage")?.textContent?.trim() || "",
      holding: document.querySelector("#objectTrainingHolding")?.textContent?.trim() || "",
      front: document.querySelector("#frontText")?.textContent?.trim() || ""
    };
  })()`, `训练程序结束并输出 ${sentinel}`, {
    timeoutMs,
    intervalMs: 25,
    accept: value => Boolean(value?.error || value?.output?.includes(sentinel))
  });
  assert.equal(result.error, undefined, result.error || "训练程序出现 Python 错误");
  return result;
}

async function testGuangyangTrainingMode(page, {
  mode,
  title,
  category,
  categoryLabel,
  marker,
  formalIdentity,
  pickup = false,
  holdingLabel = ""
}) {
  log(`广阳岛同图训练：验证${categoryLabel}像素识别${pickup ? "、靠近与夹取" : ""}`);
  const selected = await selectTrainingScene(page, mode, title, formalIdentity);
  const program = [
    ...trainingObservationSource(categoryLabel, marker)
  ];
  if (pickup) {
    program.push(
      `print(${JSON.stringify(`${marker}_APPROACHED`)}, robot.approach(${JSON.stringify(categoryLabel)}, 100, 80))`,
      `near_observations = robot.observe(${JSON.stringify(categoryLabel)})`,
      `print(${JSON.stringify(`${marker}_NEAR_COUNT`)}, len(near_observations))`,
      "if near_observations:",
      `    print(${JSON.stringify(`${marker}_NEAR_CATEGORY`)}, near_observations[0]["category"])`,
      `    print(${JSON.stringify(`${marker}_NEAR_DISTANCE`)}, near_observations[0]["distanceCm"])`,
      "robot.grab()",
      `print(${JSON.stringify(`${marker}_HOLDING`)}, robot.holding())`
    );
  }
  program.push(`print(${JSON.stringify(`${marker}_DONE`)})`);

  await startTrainingProgram(page, program.join("\n"));
  await assertVirtualPixelObservation(page, {
    marker,
    category,
    categoryLabel,
    previousFrameId: selected.carVisionFrameId
  });
  const result = await waitForTrainingProgramFinished(page, `${marker}_DONE`, pickup ? 70_000 : 30_000);
  if (pickup) {
    assert.match(result.output, new RegExp(`${marker}_APPROACHED\\s+True`),
      `${categoryLabel}自动靠近 API 没有成功`);
    assert.match(result.output, new RegExp(`${marker}_NEAR_COUNT\\s+[1-9]\\d*`),
      `${categoryLabel}靠近后没有继续被真实像素检测器识别`);
    assert.match(result.output, new RegExp(`${marker}_NEAR_CATEGORY\\s+${category}`),
      `${categoryLabel}靠近后被真实像素检测器分成了错误类别`);
    const initialDistance = Number(result.output.match(new RegExp(`${marker}_DISTANCE\\s+(\\d+)`))?.[1]);
    const nearDistance = Number(result.output.match(new RegExp(`${marker}_NEAR_DISTANCE\\s+(\\d+)`))?.[1]);
    assert.ok(Number.isFinite(initialDistance) && Number.isFinite(nearDistance),
      `${categoryLabel}中、近距离像素检测没有返回有效估算距离`);
    assert.ok(nearDistance < initialDistance,
      `${categoryLabel}靠近后的像素估算距离没有减小（${initialDistance} -> ${nearDistance} cm）`);
    assert.ok(result.rows.some(text => text.includes(`自动靠近“${categoryLabel}”`)),
      `${categoryLabel}自动靠近 API 没有实际执行`);
    assert.match(result.output, new RegExp(`${marker}_HOLDING\\s+${holdingLabel}`),
      `${categoryLabel}的 grab/holding API 结果不正确`);
    assert.equal(result.holding, holdingLabel, `${categoryLabel}训练面板没有显示夹取状态`);
  }
  assert.ok(result.rows.some(text => text.includes("Python 程序执行完成")),
    `${categoryLabel}训练程序没有正常结束`);
}

function trainingNetworkCounts(diagnostics) {
  return {
    sessions: diagnostics.requests.filter(entry => {
      if (entry.method !== "POST") return false;
      try {
        return new URL(entry.url).pathname === "/api/v1/sessions";
      } catch (_error) {
        return false;
      }
    }).length,
    submissions: submissionRequests(diagnostics).length
  };
}

async function testThreeObjectTraining(page, diagnostics) {
  const formalIdentity = await captureFormalGuangyangIdentity(page);
  const networkBefore = trainingNetworkCounts(diagnostics);

  await testGuangyangTrainingMode(page, {
    mode: "target",
    title: "广阳岛识别练习：目标物投放",
    category: "target",
    categoryLabel: "目标物",
    marker: "TARGET_TRAINING",
    formalIdentity,
    pickup: true,
    holdingLabel: "目标物"
  });
  await testGuangyangTrainingMode(page, {
    mode: "obstacle",
    title: "广阳岛识别练习：障碍物绕行",
    category: "obstacle",
    categoryLabel: "障碍物",
    marker: "OBSTACLE_TRAINING",
    formalIdentity
  });
  await testGuangyangTrainingMode(page, {
    mode: "distractor",
    title: "广阳岛识别练习：混淆物移出道路",
    category: "distractor",
    categoryLabel: "混淆物",
    marker: "DISTRACTOR_TRAINING",
    formalIdentity,
    pickup: true,
    holdingLabel: "混淆物"
  });

  await testBuiltInTrainingExamples(page, formalIdentity);
  assert.deepEqual(trainingNetworkCounts(diagnostics), networkBefore,
    "广阳岛训练与示例不应创建比赛 session 或提交 submission");
  return formalIdentity;
}

async function runBuiltInTrainingExample(page, {
  exampleId,
  mode,
  visionSceneId,
  title,
  categoryLabel,
  sentinel,
  expectedMethods,
  formalIdentity,
  holdingLabel = ""
}) {
  await page.click("#loadExampleButton");
  await page.waitForValue(
    `document.querySelector("#exampleDropdown")?.hidden === false`,
    "示例菜单打开",
    { timeoutMs: 5_000, intervalMs: 20 }
  );
  const menuItem = await page.evaluate(`(() => {
    const item = document.querySelector(${JSON.stringify(`[data-example="${exampleId}"]`)});
    return item ? {
      trainingMode: item.dataset.trainingMode || "",
      scene: item.dataset.scene || ""
    } : null;
  })()`);
  assert.equal(menuItem?.trainingMode, mode, `${title}示例没有通过 data-training-mode 绑定同图训练`);
  assert.equal(menuItem?.scene, "", `${title}示例不应切换到独立训练 scene`);

  await page.click(`[data-example="${exampleId}"]`);
  const loaded = await page.waitForValue(`(() => {
    const source = document.querySelector("#pythonEditor")?.value || "";
    const selected = document.querySelector("#sceneSelect")?.value || "";
    const missionTitle = document.querySelector("#missionTitle")?.textContent?.trim() || "";
    const workbench = document.querySelector("#trainingVisionWorkbench");
    const boxCount = document.querySelectorAll("#trainingVisionOverlay [data-vision-box]").length;
    const objectIds = [
      ...(activeMission?.packages || []).map(item => item?.id),
      ...(activeMission?.objectObstacles || []).map(item => item?.id)
    ].filter(Boolean).sort();
    return selected === "guangyang"
      && missionTitle === ${JSON.stringify(title)}
      && source.includes(${JSON.stringify(sentinel)})
      && activeMission?.environment === "guangyang"
      && activeMission?.trainingOnGuangyang === true
      && activeMission?.objectTraining?.mode === ${JSON.stringify(mode)}
      && !activeMission?.competition
      && (typeof competitionSession === "undefined" || competitionSession === null)
      && (typeof activeCompetitionServerSession === "undefined" || activeCompetitionServerSession === null)
      && workbench && !workbench.hidden
      && workbench.dataset.sceneId === ${JSON.stringify(visionSceneId)}
      && workbench.dataset.status === "empty"
      && workbench.dataset.frameId === ""
      && boxCount === 0
      ? {
        source,
        selected,
        title: missionTitle,
        mapId: globalThis.CompetitionCore?.GUANGYANG_ISLAND_CONFIG?.mapId || "",
        objectIds,
        submissionId: latestCompetitionSubmissionReceipt?.submissionId || "",
        submissionRunId: latestCompetitionSubmissionReceipt?.recordRef?.runId || "",
        latestRecordRunId: latestCompetitionRecord?.runId || "",
        visionSceneId: workbench.dataset.sceneId,
        boxCount
      }
      : null;
  })()`, `内置示例“${title}”进入广阳岛同图训练`);
  assert.equal(loaded.mapId, formalIdentity.mapId, `${title}示例更换了广阳岛 mapId`);
  assert.deepEqual(loaded.objectIds, formalIdentity.objectIds, `${title}示例更换了正式三类物体 ID`);
  assert.equal(loaded.submissionId, formalIdentity.submissionId, `${title}示例改变了已归档 submission`);
  assert.equal(loaded.submissionRunId, formalIdentity.submissionRunId, `${title}示例改变了 submission 对应 runId`);
  assert.equal(loaded.latestRecordRunId, formalIdentity.latestRecordRunId, `${title}示例改变了正式运行记录`);
  assert.match(loaded.source, new RegExp(`robot\\.observe\\(["']${categoryLabel}["']\\)`),
    `${title}示例没有使用类别观察 API`);
  const robotMethods = [...loaded.source.matchAll(/\brobot\.([a-z_]+)\s*\(/g)].map(match => match[1]);
  assert.ok(robotMethods.length > 0, `${title}示例没有调用任何视觉/夹爪 API`);
  assert.equal(robotMethods.every(method => ["observe", "approach", "grab", "holding", "road_state"].includes(method)), true,
    `${title}示例包含自动投放或硬编码绕行指令：${robotMethods.join(", ")}`);
  expectedMethods.forEach(method => assert.ok(robotMethods.includes(method), `${title}示例缺少 robot.${method}()`));
  assert.doesNotMatch(loaded.source, /\b(?:objectId|packageId|position|worldX|worldZ)\b|(?:target|distractor)-1/,
    `${title}示例泄露了对象编号或世界坐标字段`);

  await page.click("#runButton");
  await page.waitForValue(`(() => {
    const rows = [...document.querySelectorAll("#actionLog .log-text")].map(row => row.textContent || "");
    return rows.some(text => text.includes("从当前位置开始运行 Python 程序"));
  })()`, `${title}示例开始运行`, { timeoutMs: 10_000, intervalMs: 20 });
  const result = await waitForTrainingProgramFinished(page, sentinel, 70_000);
  if (holdingLabel) {
    assert.match(result.output, new RegExp(`夹爪当前持有：\\s*${holdingLabel}`),
      `${title}示例没有通过 grab/holding 返回${holdingLabel}`);
  }
}

async function testBuiltInTrainingExamples(page, formalIdentity) {
  log("广阳岛同图训练：验证示例只用感知、局部靠近、夹取与道路传感 API");
  await runBuiltInTrainingExample(page, {
    exampleId: "training-target",
    mode: "target",
    visionSceneId: "target-delivery",
    title: "广阳岛识别练习：目标物投放",
    categoryLabel: "目标物",
    sentinel: "下一步：自行搜索存放点并规划道路路线",
    expectedMethods: ["observe", "approach", "grab", "holding"],
    holdingLabel: "目标物",
    formalIdentity
  });
  await runBuiltInTrainingExample(page, {
    exampleId: "training-obstacle",
    mode: "obstacle",
    visionSceneId: "obstacle-avoidance",
    title: "广阳岛识别练习：障碍物绕行",
    categoryLabel: "障碍物",
    sentinel: "请规划其他道路绕开",
    expectedMethods: ["observe"],
    formalIdentity
  });
  await runBuiltInTrainingExample(page, {
    exampleId: "training-distractor",
    mode: "distractor",
    visionSceneId: "distractor-removal",
    title: "广阳岛识别练习：混淆物移出道路",
    categoryLabel: "混淆物",
    sentinel: "下一步：自行选择道路边界，保持小车在路内并把混淆物完整释放到边界外",
    expectedMethods: ["observe", "approach", "grab", "holding", "road_state"],
    holdingLabel: "混淆物",
    formalIdentity
  });
}

async function returnToCompetitionAndCheckTrainingVisionHidden(page, formalIdentity) {
  log("视觉台专项：验证退出训练后恢复同一正式赛图并清除训练帧");
  await page.click("#guangyangTrainingButton");
  const state = await page.waitForValue(`(() => {
    const selected = document.querySelector("#sceneSelect")?.value || "";
    const hud = document.querySelector("#competitionHud");
    const trainingPanel = document.querySelector("#objectTrainingPanel");
    if (selected !== "guangyang"
      || activeMission?.environment !== "guangyang"
      || activeMission?.trainingOnGuangyang === true
      || !activeMission?.competition?.config?.mapId
      || !hud || hud.hidden || !trainingPanel?.hidden) return null;
    return {
      mapId: activeMission.competition.config.mapId,
      objectIds: [
        ...(activeMission.packages || []).map(item => item?.id),
        ...(activeMission.objectObstacles || []).map(item => item?.id)
      ].filter(Boolean).sort(),
      submissionId: latestCompetitionSubmissionReceipt?.submissionId || "",
      latestRecordRunId: latestCompetitionRecord?.runId || ""
    };
  })()`, "退出训练并返回广阳岛正式比赛", { timeoutMs: 15_000 });
  assert.equal(state.mapId, formalIdentity.mapId, "退出训练后没有恢复同一 mapId");
  assert.deepEqual(state.objectIds, formalIdentity.objectIds, "退出训练后正式三类物体 ID 发生变化");
  assert.equal(state.submissionId, formalIdentity.submissionId, "退出训练后已归档 submission 发生变化");
  assert.equal(state.latestRecordRunId, formalIdentity.latestRecordRunId, "退出训练后正式运行记录发生变化");
  await assertTrainingVisionWorkbenchHidden(page, "返回广阳岛后");
}

function submissionRequests(diagnostics, startIndex = 0) {
  return diagnostics.requests.slice(startIndex).filter(entry => {
    if (entry.method !== "POST") return false;
    try {
      return /^\/api\/v1\/sessions\/ses_[a-f0-9]{32}\/submissions$/.test(new URL(entry.url).pathname);
    } catch (_error) {
      return false;
    }
  });
}

function draftSaveRequests(diagnostics, startIndex = 0) {
  return diagnostics.requests.slice(startIndex).filter(entry => {
    if (entry.method !== "POST") return false;
    try {
      return /^\/api\/v1\/sessions\/ses_[a-f0-9]{32}\/drafts$/.test(new URL(entry.url).pathname);
    } catch (_error) {
      return false;
    }
  });
}

function recordSubmitRequests(diagnostics, startIndex = 0) {
  return diagnostics.requests.slice(startIndex).filter(entry => {
    if (entry.method !== "POST") return false;
    try {
      return /^\/api\/v1\/records\/sub_[a-f0-9]{32}\/submit$/.test(new URL(entry.url).pathname);
    } catch (_error) {
      return false;
    }
  });
}

async function assertAutoSavedDraftWithoutFormalSubmission(page, diagnostics, requestStartIndex) {
  log("3/8 确认运行结束后自动保存草稿，但不会自动正式提交");
  const savedState = await page.waitForValue(
    runStateExpression(),
    "运行记录自动保存完成",
    {
      timeoutMs: 45_000,
      accept: value => /运行已结束|任务完成/.test(value?.state || "")
        && value?.submissionStatus === "saved"
        && /自动保存/.test(value?.submissionText || "")
    }
  );
  await delay(750);
  const drafts = draftSaveRequests(diagnostics, requestStartIndex);
  assert.equal(drafts.length, 1,
    `一次运行应恰好自动保存一条草稿，实际 ${drafts.length} 条`);
  assert.equal(
    submissionRequests(diagnostics, requestStartIndex).length,
    0,
    "自动保存草稿不得调用旧的 session submission 端点"
  );
  assert.equal(recordSubmitRequests(diagnostics, requestStartIndex).length, 0,
    "用户进入记录页并点击前不得正式提交草稿");
  assert.match(savedState.submissionText, /自动保存.*尚未正式提交/,
    `自动保存后的状态说明不清晰：${savedState.submissionText || "（空）"}`);
  assert.notEqual(savedState.actionStatus, "error", savedState.actionText || "自动保存状态异常");

  const summary = await page.evaluate(`fetch("/api/v1/records?limit=12", { credentials: "same-origin" })
    .then(async response => ({ status: response.status, body: await response.json() }))`);
  assert.equal(summary.status, 200, "自动保存后无法读取个人记录");
  assert.equal(summary.body?.records?.length, 1, "隔离账号应恰好有一条自动保存记录");
  const [savedRecord] = summary.body.records;
  assert.match(savedRecord?.id || "", /^sub_[a-f0-9]{32}$/,
    "自动保存记录缺少合法编号");
  assert.equal(savedRecord.recordState, "saved", "自动保存记录被错误标记为已提交");
  assert.equal(savedRecord.submissionId, null, "草稿在用户点击前不应有 submissionId");
  assert.equal(savedRecord.submittedAt, null, "草稿在用户点击前不应有提交时间");
  return savedRecord;
}

async function expandCompetitionHudForRecordActions(page) {
  log("记录操作：真实展开默认折叠的实时评测详情");
  const initial = await page.evaluate(`({
    expanded: document.querySelector("#competitionHudToggle")?.getAttribute("aria-expanded") || "",
    bodyHidden: Boolean(document.querySelector("#competitionHudBody")?.hidden)
  })`);
  assert.equal(initial.expanded, "false", "首次记录操作前实时评测应默认折叠");
  assert.equal(initial.bodyHidden, true, "折叠状态下实时评测详情仍可见");
  await page.click("#competitionHudToggle");
  const expanded = await page.waitForValue(`(() => {
    const toggle = document.querySelector("#competitionHudToggle");
    const body = document.querySelector("#competitionHudBody");
    const selectors = ["#replayRunRecordButton", "#exportRunRecordButton", "#verifyRunRecordButton"];
    const buttons = selectors.map(selector => document.querySelector(selector));
    const isVisible = element => {
      if (!element || element.hidden || element.closest("[hidden], [inert]")) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    if (toggle?.getAttribute("aria-expanded") !== "true" || body?.hidden || body?.inert) return null;
    if (!buttons.every(isVisible)) return null;
    return {
      expanded: toggle.getAttribute("aria-expanded"),
      bodyHidden: body.hidden,
      bodyInert: body.inert,
      visibleButtons: buttons.map(button => button.id),
      disabledButtons: buttons.filter(button => button.disabled).map(button => button.id)
    };
  })()`, "实时评测详情展开且记录操作可见", { timeoutMs: 10_000 });
  assert.equal(expanded.expanded, "true", "实时评测开关没有标记 aria-expanded=true");
  assert.equal(expanded.bodyHidden, false, "实时评测详情展开后仍被 hidden");
  assert.equal(expanded.bodyInert, false, "实时评测详情展开后仍为 inert");
  assert.deepEqual(expanded.visibleButtons, [
    "replayRunRecordButton", "exportRunRecordButton", "verifyRunRecordButton"
  ], "展开实时评测后回放、导出、校验按钮没有全部可见");
  assert.deepEqual(expanded.disabledButtons, [], "运行记录就绪后仍有记录操作按钮被禁用");
}

async function replayCurrentRecord(page, timeoutMs = 30_000, { recoveryGuangyang = false } = {}) {
  log("4/8 真实点击回放按钮并等待确定性回放完成");
  await page.click("#replayRunRecordButton");
  await page.waitForValue(
    `document.querySelector("#replayRunRecordButton")?.getAttribute("aria-pressed") === "true"`,
    "回放按钮进入运行状态",
    { timeoutMs: 10_000, intervalMs: 20 }
  );
  const result = await page.waitForValue(
    `(() => {
      const button = document.querySelector("#replayRunRecordButton");
      const action = document.querySelector("#competitionRecordActionStatus");
      if (button?.getAttribute("aria-pressed") !== "false" || action?.dataset?.action !== "replay") return null;
      if (["success", "warning", "error"].includes(action?.dataset?.status || "")) {
        return { status: action.dataset.status, text: action.textContent?.trim() || "" };
      }
      return null;
    })()`,
    "回放结束",
    { timeoutMs, intervalMs: 25 }
  );
  assert.equal(result.status, "success", result.text || "确定性回放没有成功");
  assert.match(result.text, /确定性回放完成/);
  if (recoveryGuangyang) {
    const replayed = await page.evaluate(recoveryMissionStateExpression());
    assertRecoveryMissionState(replayed, "当前记录回放 DOM");
    assert.equal(replayed.runState, "运行已结束", "7/8 当前回放不应显示任务完成");
  }
}

const NAVIGATION_QUERY_RESULT_FIELDS = Object.freeze({
  odometry: Object.freeze(["distanceCm", "forwardCm", "headingDeg", "rightCm", "tick"]),
  road_state: Object.freeze([
    "atJunction", "atNode", "exits", "fromNodeId", "frontClearanceCm", "headingErrorDeg", "junctionId",
    "lateralOffsetCm", "leftClearanceCm", "nodeId", "onRoad", "rightClearanceCm", "roadId", "roadIds",
    "roadProgressCm", "tick", "toNodeId"
  ]),
  map_graph: Object.freeze(["edges", "nodes", "schemaVersion"])
});
const NAVIGATION_CONTROL_RESULT_FIELDS = Object.freeze([
  "accepted", "distanceCm", "elapsedTicks", "roadId", "stoppedBy"
]);
const NAVIGATION_ABSOLUTE_COORDINATE_FIELDS = new Set([
  "coordinate", "coordinates", "initialpose", "nearestpoint", "points", "pose",
  "position", "segmentindex", "sourceposition", "tangent", "worldx", "worldz", "x", "z"
]);
const NAVIGATION_CONTROL_INTERNAL_FIELDS = new Set([
  "command", "commands", "control", "controls", "drive", "endstate", "internalcommand",
  "startstate", "steering", "throttle", "velocity"
]);

function assertNoAbsoluteNavigationCoordinates(value, location = "navigation_query.result") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAbsoluteNavigationCoordinates(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([key, item]) => {
    assert.equal(
      NAVIGATION_ABSOLUTE_COORDINATE_FIELDS.has(key.toLowerCase()),
      false,
      `${location}.${key} 泄露了绝对坐标或内部道路几何`
    );
    assertNoAbsoluteNavigationCoordinates(item, `${location}.${key}`);
  });
}

function assertNoInternalNavigationControlState(value, location = "navigation_control") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInternalNavigationControlState(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([key, item]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    assert.equal(
      NAVIGATION_CONTROL_INTERNAL_FIELDS.has(normalizedKey),
      false,
      `${location}.${key} 泄露了内部控制命令或私有状态`
    );
    assertNoInternalNavigationControlState(item, `${location}.${key}`);
  });
}

function assertStandardNavigationQueries(record) {
  const navigationQueries = record.inputs.filter(input => input?.type === "navigation_query");
  assert.deepEqual(
    navigationQueries.map(input => input.method),
    ["map_graph", "odometry", "road_state", "odometry"],
    "短程序没有按预期记录道路拓扑、起点里程、道路状态和移动后里程"
  );
  navigationQueries.forEach((input, index) => {
    assert.deepEqual(
      Object.keys(input).sort(),
      ["method", "result", "seq", "t", "tick", "type"],
      `第 ${index + 1} 条 navigation_query 包含未冻结字段`
    );
    assert.deepEqual(
      Object.keys(input.result || {}).sort(),
      NAVIGATION_QUERY_RESULT_FIELDS[input.method],
      `第 ${index + 1} 条 ${input.method} 返回字段不符合公开契约`
    );
    assertNoAbsoluteNavigationCoordinates(input.result, `navigation_query[${index}].result`);
  });
  const graph = navigationQueries[0].result;
  assert.equal(graph.schemaVersion, "chenlong.road-graph/v1", "map_graph 版本不正确");
  assert.ok(Array.isArray(graph.nodes) && graph.nodes.length > 0, "map_graph 没有公开道路节点");
  assert.ok(Array.isArray(graph.edges) && graph.edges.length > 0, "map_graph 没有公开道路边");
  graph.nodes.forEach((node, index) => {
    assert.deepEqual(Object.keys(node).sort(), ["nodeId", "roadIds"], `第 ${index + 1} 个节点字段不安全`);
  });
  graph.edges.forEach((edge, index) => {
    assert.deepEqual(Object.keys(edge).sort(), ["fromNodeId", "lengthCm", "oneWay", "roadId", "toNodeId"],
      `第 ${index + 1} 条道路字段不安全`);
  });
  assert.deepEqual(navigationQueries[1].result, {
    forwardCm: 0,
    rightCm: 0,
    headingDeg: 0,
    distanceCm: 0,
    tick: 0
  }, "首次 odometry 不是本次程序起点的零状态");
  assert.equal(navigationQueries[2].result.onRoad, true, "广阳岛起点没有识别为可行驶道路");
  assert.ok(navigationQueries[2].result.roadId, "road_state 没有返回公开道路编号");
  assert.ok(Array.isArray(navigationQueries[2].result.exits), "road_state 没有固定返回 exits 数组");
  assert.ok(navigationQueries[3].result.distanceCm > 0, "移动后的 odometry 没有累计实际里程");
  assert.ok(navigationQueries[3].result.tick > navigationQueries[1].result.tick,
    "移动后的 odometry tick 没有推进");
}

function assertStandardNavigationControls(record) {
  const navigationControls = record.inputs.filter(input => input?.type === "navigation_control");
  assert.equal(navigationControls.length, 1, "短程序应恰好记录一条 navigation_control");
  const [control] = navigationControls;
  assert.deepEqual(
    Object.keys(control).sort(),
    ["args", "method", "result", "seq", "t", "tick", "type"],
    "navigation_control 包含未冻结字段"
  );
  assert.equal(control.method, "follow_road", "短程序记录的道路控制不是 follow_road");
  assert.deepEqual(
    control.args,
    { maxCm: 20, speed: 40, obeySpeedLimit: false },
    "follow_road 参数没有按公开契约记录"
  );
  assert.deepEqual(
    Object.keys(control.result || {}).sort(),
    NAVIGATION_CONTROL_RESULT_FIELDS,
    "follow_road 返回字段不符合公开契约"
  );
  assert.equal(control.result.accepted, true, "安全短程 follow_road 没有被接受");
  assert.equal(control.result.stoppedBy, "max_distance", "安全短程 follow_road 没有按距离停止");
  assert.ok(typeof control.result.roadId === "string" && control.result.roadId.length > 0,
    "follow_road 没有返回公开道路编号");
  assert.equal(control.result.distanceCm, 20, "follow_road 没有完成约定的 20 厘米安全短程");
  assert.ok(Number.isSafeInteger(control.result.elapsedTicks) && control.result.elapsedTicks > 0,
    "follow_road 没有返回有效的确定性耗时 tick");
  assertNoAbsoluteNavigationCoordinates(control, "navigation_control");
  assertNoInternalNavigationControlState(control);
  assert.equal(record.inputs.some(input => input?.type === "control"), false,
    "道路控制的内部逐 tick 命令不应进入客户端输入记录");
}

async function exportRecord(page, connection, downloadsDir, {
  fullGuangyang = false,
  recoveryGuangyang = false,
  topologyPlanner = false
} = {}) {
  log("5/8 真实点击导出并校验下载的 v4 RunRecord");
  const downloadStarted = connection.waitForEvent("Browser.downloadWillBegin", () => true, 15_000);
  await page.click("#exportRunRecordButton");
  const start = await downloadStarted;
  assert.match(start.suggestedFilename || "", /\.json$/i, "导出文件不是 JSON");
  const completed = await connection.waitForEvent(
    "Browser.downloadProgress",
    params => params.guid === start.guid && ["completed", "canceled"].includes(params.state),
    30_000
  );
  assert.equal(completed.state, "completed", "浏览器取消了 RunRecord 下载");
  const expectedPath = path.join(downloadsDir, start.suggestedFilename);
  const downloadedPath = await waitUntil(async () => {
    const candidate = completed.filePath && fs.existsSync(completed.filePath) ? completed.filePath : expectedPath;
    try {
      const stat = await fsPromises.stat(candidate);
      return stat.isFile() && stat.size > 0 ? candidate : null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }, "导出文件写入磁盘", 10_000, 50);
  const record = JSON.parse(await fsPromises.readFile(downloadedPath, "utf8"));
  assert.equal(record.schemaVersion, "chenlong.run-record/v4", "导出的记录不是 v4 RunRecord");
  assert.match(record.runId || "", /^run_[a-f0-9]{32}$/, "导出的运行编号格式错误");
  assert.match(record.serverSessionId || "", /^ses_[a-f0-9]{32}$/, "导出记录没有绑定服务端场次");
  if (fullGuangyang || recoveryGuangyang) {
    const taskDefinition = record.runDefinition?.taskDefinition;
    assert.equal(taskDefinition?.schemaVersion, "chenlong.task/v5",
      "广阳岛正式记录没有冻结任意道路边界移除规则");
    const distractorDelivery = taskDefinition?.deliveries?.find(item => item?.objectRole === "distractor");
    assert.equal(distractorDelivery?.destinationRole, "offroad-removal",
      "混淆物任务没有标记为道路外移除");
    assert.equal(distractorDelivery?.placementRule, "road-edge-clearance",
      "混淆物任务仍依赖固定投放区");
    assert.equal(Object.hasOwn(distractorDelivery || {}, "destination"), false,
      "道路外移除规则不应泄露或依赖固定目的地坐标");
    assert.equal(Object.hasOwn(distractorDelivery || {}, "radius"), false,
      "道路外移除规则不应依赖固定目的地区域半径");
    assert.ok(Number(distractorDelivery?.minimumRoadEdgeClearance) > 0,
      "道路外移除规则缺少物体离道路边界的最小净距");
    assert.ok(Array.isArray(taskDefinition?.placementGeometry?.roads)
      && taskDefinition.placementGeometry.roads.length > 0,
      "道路外移除规则没有冻结用于服务端重算的道路几何");
  }
  if (recoveryGuangyang) {
    assert.equal(record.result?.reason, "program_finished", "恢复路线不应以任务完成结束");
    assert.equal(record.result?.taskFinished, false, "恢复路线记录错误标记为任务完成");
    assert.equal(record.result?.completedTasks, 7, "恢复路线记录不是 7/8");
    assert.equal(record.result?.totalTasks, 8, "恢复路线记录任务总数不是 8");
    assert.equal(record.result?.taskScore, 35, "恢复路线记录的任务分不是 35");
    assert.equal(record.result?.ruleScore, 23.3, "恢复路线没有且仅扣一次碰撞规则分");
    assert.equal(record.result?.autonomousScore, 15, "恢复路线不应扣自主控制分");
    assert.equal(record.result?.efficiencyScore, 0, "恢复路线的超目标时长不应获得效率分");
    assert.equal(record.result?.score, 73.3, "恢复路线记录总分不是 73.3");
    assert.deepEqual(
      (record.result?.violations || []).map(item => [item.type, item.colliderId]),
      [["collision", "object:guangyang-obstacle-1"]],
      "恢复路线结果没有且仅有一次指定障碍碰撞"
    );
    assert.ok(Object.values(record.result?.violationMetrics || {}).every(metric => (
      Number(metric?.episodes || 0) === 0
      && Number(metric?.durationMs || 0) === 0
      && Number(metric?.maxSeverity || 0) === 0
    )), "恢复路线出现了碰撞以外的连续违规指标");
    assert.deepEqual(
      record.events.filter(event => event.type === "checkpoint").map(event => event.checkpointId),
      ["checkpoint-ds-lake", "checkpoint-egret", "checkpoint-rapeseed", "checkpoint-camp"],
      "恢复路线记录的检查点顺序不正确"
    );
    assert.deepEqual(
      record.events.filter(event => event.type === "package_delivered")
        .map(event => [event.objectRole, event.destinationRole]),
      [["target", "storage"], ["distractor", "offroad-removal"]],
      "恢复路线记录缺少两类投放事件"
    );
    assert.ok(record.events.some(event => event.type === "goal_reached"), "恢复路线记录缺少返航事件");
    assert.equal(record.events.some(event => event.type === "task_completed"), false,
      "7/8 恢复路线不应包含 task_completed");
    assert.deepEqual(
      record.events.filter(event => event.type === "violation")
        .map(event => [event.violationType, event.colliderId]),
      [["collision", "object:guangyang-obstacle-1"]],
      "恢复路线审计事件没有且仅有指定障碍碰撞"
    );
    assert.equal(record.inputs.some(input => input?.type === "vision_query"), false,
      "恢复记录不应包含不可重算的视觉查询");
    assert.equal(record.inputs.some(input => input?.type === "manual_control"), false,
      "恢复路线应保持零人工干预");
  } else if (topologyPlanner) {
    assert.equal(record.result?.reason, "completed", "图规划程序没有以任务完成结束");
    assert.equal(record.result?.taskFinished, true, "图规划程序记录没有标记任务完成");
    assert.equal(record.result?.completedTasks, 8, "图规划程序记录不是 8/8");
    assert.equal(record.result?.totalTasks, 8, "图规划程序任务总数不是 8");
    assert.equal(record.result?.taskScore, 40, "图规划程序任务分不是 40");
    assert.equal(record.result?.ruleScore, 25, "图规划程序没有保留满规则分");
    assert.equal(record.result?.autonomousScore, 15, "图规划程序没有保留满自主分");
    assert.ok(Number(record.result?.score) >= 95, "图规划程序总分低于 95");
    assert.deepEqual(record.result?.violations, [], "图规划程序结果包含违规");
    assert.ok(record.inputs.some(input => input?.type === "navigation_query"),
      "图规划程序没有记录导航传感使用");
    assert.ok(record.inputs.some(input => input?.type === "navigation_control"),
      "图规划程序没有记录道路控制使用");
  } else if (fullGuangyang) {
    assert.equal(record.result?.reason, "completed", "广阳岛完整路线没有以任务完成结束");
    assert.equal(record.result?.taskFinished, true, "广阳岛完整路线记录没有标记任务完成");
    assert.equal(record.result?.completedTasks, 8, "广阳岛完整路线记录不是 8/8");
    assert.equal(record.result?.totalTasks, 8, "广阳岛完整路线记录任务总数不是 8");
    assert.equal(record.result?.taskScore, 40, "广阳岛完整路线记录任务分不是 40");
    assert.equal(record.result?.ruleScore, 25, "广阳岛安全路线没有保留满规则分");
    assert.equal(record.result?.autonomousScore, 15, "广阳岛安全路线没有保留满自主分");
    assert.ok(Number(record.result?.score) >= 98.8, "广阳岛道路外移除安全路线总分低于 98.8");
    assert.deepEqual(record.result?.violations, [], "广阳岛安全路线结果包含违规");
    assert.ok(Object.values(record.result?.violationMetrics || {}).every(metric => (
      Number(metric?.episodes || 0) === 0
      && Number(metric?.durationMs || 0) === 0
      && Number(metric?.maxSeverity || 0) === 0
    )), "广阳岛安全路线存在非零违规指标");
    assert.deepEqual(
      record.events.filter(event => event.type === "checkpoint").map(event => event.checkpointId),
      ["checkpoint-ds-lake", "checkpoint-egret", "checkpoint-rapeseed", "checkpoint-camp"],
      "广阳岛完整路线记录的检查点顺序不正确"
    );
    assert.deepEqual(
      record.events.filter(event => event.type === "package_delivered").map(event => [event.objectRole, event.destinationRole]),
      [["target", "storage"], ["distractor", "offroad-removal"]],
      "广阳岛完整路线记录缺少两类投放事件"
    );
    assert.ok(record.events.some(event => event.type === "goal_reached"), "广阳岛完整路线记录缺少返航事件");
    assert.ok(record.events.some(event => event.type === "task_completed"), "广阳岛完整路线记录缺少完成事件");
    assert.equal(record.inputs.some(input => input?.type === "vision_query"), false,
      "完整可复算记录不应包含不可重算的视觉查询");
    assert.equal(record.inputs.some(input => input?.type === "manual_control"), false,
      "完整安全路线应保持零人工干预");
    assert.equal(record.events.some(event => event.type === "violation"), false,
      "无违规安全路线记录出现了违规事件");
  } else {
    assert.equal(record.result?.reason, "program_finished", "短程序的结束原因不符合预期");
    assertStandardNavigationQueries(record);
    assertStandardNavigationControls(record);
    const visionQueries = record.inputs.filter(input => input?.type === "vision_query");
    assert.equal(visionQueries.length, 1, "短程序应恰好记录一次真实像素 vision_query");
    assert.equal(visionQueries[0]?.method, "observe", "短程序记录的视觉查询不是 observe");
    assert.equal(visionQueries[0]?.args?.[0], "target", "短程序视觉查询类别没有按公开 API 规范化");
    assert.ok(record.visionFrames.some(frame => frame?.frameId === visionQueries[0]?.frameId),
      "短程序 vision_query 没有关联真实 PNG 摄像头证据");
  }
  return { record, downloadedPath };
}

async function verifyRecord(page, {
  expectedStatus = null,
  recoveryGuangyang = false,
  topologyPlanner = false,
  expectedVisionQueryCount = null,
  expectedNavigationQueryCount = null,
  expectedNavigationControlCount = null
} = {}) {
  log("6/8 真实点击服务端校验并读取页面反馈");
  await page.click("#verifyRunRecordButton");
  const result = await page.waitForValue(
    `(() => {
      const action = document.querySelector("#competitionRecordActionStatus");
      if (action?.dataset?.action !== "verify" || action?.dataset?.status === "checking") return null;
      return {
        status: action?.dataset?.status || "",
        text: action?.textContent?.trim() || "",
        report: document.querySelector("#competitionVerifierResult")?.textContent?.trim() || "",
        reportStatus: document.querySelector("#competitionVerifierResult")?.dataset?.status || ""
      };
    })()`,
    "服务端校验完成",
    { timeoutMs: 45_000 }
  );
  assert.ok(["success", "warning"].includes(result.status), result.text || "服务端校验失败");
  assert.match(result.text, /服务端校验完成/);
  assert.match(result.report, /authoritative: false/);
  if (expectedStatus) {
    assert.equal(result.reportStatus, expectedStatus, `服务端校验状态不是 ${expectedStatus}`);
  }
  if (expectedStatus || expectedVisionQueryCount !== null || expectedNavigationQueryCount !== null
    || expectedNavigationControlCount !== null) {
    const detailed = await page.evaluate(`fetch("/api/v1/verify-run-record", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(latestCompetitionRecord)
    }).then(async response => ({ status: response.status, body: await response.json() }))`, 60_000);
    assert.equal(detailed.status, 200, "服务端详细复算请求失败");
    if (expectedStatus) assert.equal(detailed.body?.status, expectedStatus, "服务端详细复算状态不一致");
    assert.deepEqual(detailed.body?.reasonCodes, [], "verified 复算报告仍包含原因码");
    assert.equal(detailed.body?.replay?.verified, true, "服务端详细复算没有通过回放验证");
    assert.equal(detailed.body?.replay?.mismatchCount, 0, "服务端详细复算发现轨迹差异");
    assert.equal(detailed.body?.capabilities?.recomputationComplete, true, "服务端没有完成全量复算");
    if (expectedNavigationQueryCount !== null) {
      const recordedNavigationCount = await page.evaluate(
        `latestCompetitionRecord?.inputs?.filter(input => input?.type === "navigation_query").length || 0`
      );
      assert.equal(recordedNavigationCount, expectedNavigationQueryCount,
        `页面记录的导航查询计数不是 ${expectedNavigationQueryCount}`);
      assert.equal(detailed.body?.capabilities?.navigationQueriesRecomputed, true,
        "服务端没有重算 navigation_query");
      assert.ok(detailed.body?.verificationScope?.deterministic?.domains?.includes("navigation_sensors"),
        "服务端确定性校验范围没有声明导航传感器");
    }
    if (expectedNavigationControlCount !== null) {
      const recordedNavigationControlCount = await page.evaluate(
        `latestCompetitionRecord?.inputs?.filter(input => input?.type === "navigation_control").length || 0`
      );
      assert.equal(recordedNavigationControlCount, expectedNavigationControlCount,
        `页面记录的道路控制计数不是 ${expectedNavigationControlCount}`);
      assert.equal(detailed.body?.capabilities?.navigationControlsRecomputed, true,
        "服务端没有重算 navigation_control");
      assert.ok(detailed.body?.verificationScope?.deterministic?.domains?.includes("navigation_controls"),
        "服务端确定性校验范围没有声明道路控制");
    }
    if (expectedVisionQueryCount !== null) {
      assert.equal(detailed.body?.capabilities?.visionQueryCount, expectedVisionQueryCount,
        `服务端视觉查询计数不是 ${expectedVisionQueryCount}`);
      if (expectedVisionQueryCount > 0) {
        assert.equal(detailed.body?.visionStatus, "matched", "服务端没有匹配真实 PNG 的视觉查询结果");
        assert.equal(detailed.body?.capabilities?.visionDetectionsRecomputed, true,
          "服务端没有从真实 PNG 重算像素检测结果");
      } else {
        assert.equal(detailed.body?.visionStatus, "not_used", "无视觉查询记录不应进入视觉重算");
        assert.equal(detailed.body?.capabilities?.visionDetectionsRecomputed, false,
          "无视觉查询记录不应标记为已重算检测结果");
      }
    }
    assert.equal(detailed.body?.resultComparison?.matched, true, "记录结果与服务端复算结果不一致");
    if (recoveryGuangyang) {
      assert.equal(detailed.body?.recomputedResult?.ruleScore, 23.3,
        "服务端复算恢复路线规则分不是 23.3");
      assert.equal(detailed.body?.recomputedResult?.autonomousScore, 15,
        "服务端复算恢复路线自主分不是 15");
      assert.equal(detailed.body?.recomputedResult?.completedTasks, 7,
        "verified 恢复记录没有保持 7/8");
      assert.equal(detailed.body?.recomputedResult?.totalTasks, 8,
        "verified 恢复记录任务总数不是 8");
      assert.equal(detailed.body?.recomputedResult?.taskFinished, false,
        "verified 只表示记录完整，不能把 7/8 记录判为任务合格");
      assert.equal(detailed.body?.recomputedResult?.reason, "program_finished",
        "verified 只表示记录完整，不能把 7/8 记录改成 completed");
      assert.equal(detailed.body?.recomputedResult?.taskScore, 35,
        "服务端恢复路线任务分不是 35");
      assert.equal(detailed.body?.recomputedResult?.score, 73.3,
        "服务端恢复路线总分不是 73.3");
      assert.equal(detailed.body?.recordedResult?.taskFinished, false,
        "服务端报告没有保留记录的不合格状态");
    } else if (topologyPlanner) {
      assert.ok(detailed.body?.recomputedResult?.score >= 95,
        "图规划程序服务端复算没有保持接近满分的成绩");
      assert.equal(detailed.body?.recomputedResult?.taskFinished, true,
        "图规划程序服务端复算没有完成任务");
    } else if (expectedVisionQueryCount === 0) {
      assert.equal(detailed.body?.recomputedResult?.ruleScore, 25,
        "服务端复算完整路线规则分不是 25");
      assert.equal(detailed.body?.recomputedResult?.autonomousScore, 15,
        "服务端复算完整路线自主分不是 15");
      assert.ok(Number(detailed.body?.recomputedResult?.score) >= 98.8, "服务端复算道路外移除路线总分低于 98.8");
    } else {
      assert.equal(detailed.body?.recomputedResult?.reason, "program_finished",
        "含真实 PNG 视觉查询的短程序结束原因不正确");
    }
  }
}

async function openWorkspaceRecordsAndSubmitSavedRow(
  page,
  diagnostics,
  exportedRecord,
  savedDraft,
  editorSource,
  requestStartIndex,
  { expectedStatus = null } = {}
) {
  log("7/8 在工作台的我的比赛记录中找到本条草稿并逐条提交");
  assert.equal(savedDraft.runId, exportedRecord.runId,
    "自动保存草稿与导出的当前 RunRecord 不是同一次运行");
  const workbenchUrl = await page.currentUrl();
  assert.equal(new URL(workbenchUrl).pathname, "/", "打开我的记录前不在仿真工作台");
  assert.equal(submissionRequests(diagnostics, requestStartIndex).length, 0,
    "打开我的记录前不应已有旧式 submission POST");
  assert.equal(recordSubmitRequests(diagnostics, requestStartIndex).length, 0,
    "打开我的记录前不应已有记录页提交 POST");
  await page.click("#recordsNavLink");
  const opened = await page.waitForValue(
    `(() => {
      const dialog = document.querySelector("#competitionRecordsDialog");
      const trigger = document.querySelector("#recordsNavLink");
      if (!dialog?.open || location.pathname !== "/") return null;
      const record = dialog.querySelector(${JSON.stringify(`#competitionRecordsList [data-record-id="${savedDraft.id}"]`)});
      const rowSubmit = record?.querySelector(".workspace-record-submit");
      if (!record || !rowSubmit) return null;
      const isVisible = element => {
        if (!element || element.hidden || element.closest("[hidden], [inert]")) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return {
        href: location.href,
        pathname: location.pathname,
        dialogOpen: true,
        expanded: trigger?.getAttribute("aria-expanded") || "",
        recordId: record.dataset.recordId || "",
        recordStatus: record.querySelector(".workspace-record-status")?.dataset?.status || "",
        recordStatusText: record.querySelector(".workspace-record-status")?.textContent?.trim() || "",
        rowSubmitVisible: isVisible(rowSubmit),
        rowSubmitDisabled: Boolean(rowSubmit.disabled),
        rowSubmitText: rowSubmit.textContent?.trim() || "",
        legacyHudSubmitVisible: isVisible(document.querySelector("#submitRunRecordButton")),
        legacyCurrentSubmitVisible: isVisible(document.querySelector("#submitPendingRunRecordButton")),
        editorSource: document.querySelector("#pythonEditor")?.value ?? null
      };
    })()`,
    "工作台内我的记录显示自动保存草稿",
    { timeoutMs: 20_000 }
  );
  assert.equal(opened.href, workbenchUrl, "打开我的记录不应改变工作台 URL");
  assert.equal(opened.pathname, "/", "我的记录不应跳转到独立页面");
  assert.equal(opened.dialogOpen, true, "我的记录应以内嵌 dialog 打开");
  assert.equal(opened.expanded, "true", "打开弹窗后触发按钮应标记 aria-expanded=true");
  assert.equal(opened.recordId, savedDraft.id, "工作台没有显示本次自动保存记录");
  assert.equal(opened.recordStatus, "saved", "工作台把自动保存草稿显示为已提交");
  assert.match(opened.recordStatusText, /未提交|已保存/,
    `工作台草稿状态不清晰：${opened.recordStatusText || "（空）"}`);
  assert.equal(opened.rowSubmitVisible, true, "我的比赛记录中本条草稿没有实际可见的提交按钮");
  assert.equal(opened.rowSubmitDisabled, false, "本条草稿的提交按钮被错误禁用");
  assert.match(opened.rowSubmitText, /提交/, "本条草稿的操作按钮没有明确标注提交");
  assert.equal(opened.legacyHudSubmitVisible, false, "评分 HUD 不应再显示独立提交按钮");
  assert.equal(opened.legacyCurrentSubmitVisible, false,
    "我的比赛记录不应显示脱离记录行的“提交当前记录”按钮");
  assert.equal(opened.editorSource, editorSource, "打开我的记录后编辑器代码发生变化");
  assert.equal(submissionRequests(diagnostics, requestStartIndex).length, 0,
    "仅打开我的记录弹窗不得隐式调用旧式提交");
  assert.equal(recordSubmitRequests(diagnostics, requestStartIndex).length, 0,
    "仅打开我的记录弹窗不得隐式提交草稿");

  await page.click(`#competitionRecordsList [data-record-id="${savedDraft.id}"] .workspace-record-submit`);
  const archived = await page.waitForValue(
    `(() => {
      const dialog = document.querySelector("#competitionRecordsDialog");
      const record = dialog?.querySelector(${JSON.stringify(`#competitionRecordsList [data-record-id="${savedDraft.id}"]`)});
      const action = record?.querySelector(".workspace-record-submit");
      const status = record?.querySelector(".workspace-record-status");
      if (!dialog?.open || !record || !action || !action.disabled) return null;
      if (!/已提交/.test(action.textContent || "")) return null;
      if (!/verified|partial/.test(status?.dataset?.status || "")) return null;
      return {
        recordId: record.dataset.recordId || "",
        rowText: record.textContent?.trim() || "",
        status: status?.dataset?.status || "",
        dialogStatus: document.querySelector("#competitionRecordsStatus")?.textContent?.trim() || "",
        editorSource: document.querySelector("#pythonEditor")?.value ?? null
      };
    })()`,
    "我的比赛记录完成本条记录的正式提交",
    { timeoutMs: 60_000 }
  );
  assert.equal(archived.recordId, savedDraft.id, "提交后弹窗显示了错误记录");
  assert.ok(["verified", "partial"].includes(archived.status),
    `明确提交后的状态异常：${archived.status || archived.dialogStatus}`);
  if (expectedStatus) assert.equal(archived.status, expectedStatus,
    `明确提交后的存档状态不是 ${expectedStatus}`);
  assert.equal(archived.editorSource, editorSource, "逐条提交并刷新记录列表后编辑器源码丢失");
  const posts = recordSubmitRequests(diagnostics, requestStartIndex);
  assert.equal(posts.length, 1,
    `一次明确提交应恰好产生一个 /api/v1/records/:id/submit POST，实际 ${posts.length} 个`);
  assert.equal(new URL(posts[0].url).pathname, `/api/v1/records/${savedDraft.id}/submit`,
    "逐条提交请求没有绑定当前草稿编号");
  assert.equal(submissionRequests(diagnostics, requestStartIndex).length, 0,
    "记录页提交不得回退到旧式 session submission 端点");

  const summary = await page.evaluate(`fetch("/api/v1/records?limit=1", { credentials: "same-origin" })
    .then(async response => ({ status: response.status, body: await response.json() }))`);
  assert.equal(summary.status, 200, "浏览器会话无法读取个人记录 API");
  assert.equal(summary.body?.records?.length, 1);
  assert.equal(summary.body.records[0].runId, exportedRecord.runId, "导出记录与后台存档 runId 不一致");
  assert.equal(summary.body.records[0].recordState, "submitted", "记录页提交后后台仍标记为草稿");
  assert.equal(summary.body.records[0].submissionId || summary.body.records[0].id, savedDraft.id,
    "弹窗记录编号与个人记录 API 不一致");
  if (expectedStatus) assert.equal(summary.body.records[0].status, expectedStatus,
    `明确提交后的存档状态不是 ${expectedStatus}`);

  await page.click("#closeCompetitionRecordsButton");
  const closed = await page.waitForValue(`(() => {
    const dialog = document.querySelector("#competitionRecordsDialog");
    if (dialog?.open) return null;
    return {
      href: location.href,
      expanded: document.querySelector("#recordsNavLink")?.getAttribute("aria-expanded") || "",
      editorSource: document.querySelector("#pythonEditor")?.value ?? null
    };
  })()`, "关闭我的比赛记录弹窗");
  assert.equal(closed.href, workbenchUrl, "关闭我的比赛记录后工作台 URL 发生变化");
  assert.equal(closed.expanded, "false", "关闭记录弹窗后触发按钮未恢复折叠状态");
  assert.equal(closed.editorSource, editorSource, "关闭我的比赛记录后编辑器源码丢失");
  return savedDraft.id;
}

async function replayArchivedRecordAfterReload(
  page,
  diagnostics,
  timeoutMs = 45_000,
  { recoveryGuangyang = false, expectedEditorSource = null } = {}
) {
  log("8/8 主动刷新工作台并从后台存档载入回放");
  const requestStartIndex = diagnostics.requests.length;
  await page.reload(30_000);
  await page.waitForValue(
    `location.pathname === "/" && Boolean(document.querySelector("#simCanvas"))`,
    "刷新后重新进入仿真工作台",
    { timeoutMs: 20_000 }
  );
  await waitForPython(page);
  const initialState = await page.evaluate(`({
    runState: document.querySelector("#competitionRunState")?.textContent?.trim() || "",
    editorSource: document.querySelector("#pythonEditor")?.value ?? null
  })`);
  assert.equal(initialState.runState, "等待运行", "新页面不应保留上一页的内存运行状态");
  if (expectedEditorSource !== null) {
    assert.equal(initialState.editorSource, expectedEditorSource,
      "返回工作台并刷新后编辑器源码丢失");
  }
  await page.click("#replayRunRecordButton");
  const result = await page.waitForValue(
    `(() => {
      const action = document.querySelector("#competitionRecordActionStatus");
      const button = document.querySelector("#replayRunRecordButton");
      if (action?.dataset?.action !== "replay" || button?.getAttribute("aria-pressed") !== "false") return null;
      if (["success", "warning", "error"].includes(action?.dataset?.status || "")) {
        return { status: action.dataset.status, text: action.textContent?.trim() || "" };
      }
      return null;
    })()`,
    "后台存档回放完成",
    { timeoutMs, intervalMs: 25 }
  );
  assert.equal(result.status, "success", result.text || "后台存档回放失败");
  assert.match(result.text, /确定性回放完成/);
  if (expectedEditorSource !== null) {
    const editorSource = await page.evaluate(`document.querySelector("#pythonEditor")?.value ?? null`);
    assert.equal(editorSource, expectedEditorSource, "从后台回放已提交记录后编辑器源码丢失");
  }
  if (recoveryGuangyang) {
    const replayed = await page.evaluate(recoveryMissionStateExpression());
    assertRecoveryMissionState(replayed, "刷新后后台存档回放 DOM");
    assert.equal(replayed.runState, "运行已结束", "刷新后的 7/8 回放不应显示任务完成");
  }
  const recentRequests = diagnostics.requests.slice(requestStartIndex).map(item => item.url);
  assert.ok(recentRequests.some(url => /\/api\/v1\/records\?limit=1$/.test(url)), "回放未请求最近个人存档");
  assert.ok(recentRequests.some(url => /\/api\/v1\/records\/sub_[a-f0-9]{32}\/run-record$/.test(url)), "回放未请求后台 RunRecord");
}

async function resetRecoveryMissionState(page) {
  log("9/10 点击重置，确认当前任务状态清零且上一局成绩仍可查看");
  await page.click("#resetButton");
  const reset = await page.waitForValue(`(() => {
    const avoidance = document.querySelector("#missionAvoidanceProgress");
    const missionValue = document.querySelector("#missionProgressValue")?.textContent?.trim() || "";
    const runState = document.querySelector("#competitionRunState")?.textContent?.trim() || "";
    if (missionValue !== "0/8" || runState !== "上一局结果") return null;
    return {
      runState,
      missionValue,
      missionHint: document.querySelector("#missionProgressHint")?.textContent?.trim() || "",
      missionBar: document.querySelector("#missionProgressBar")?.style?.width || "",
      delivery: document.querySelector("#missionDeliveryProgress")?.textContent?.trim() || "",
      avoidance: avoidance?.textContent?.trim() || "",
      avoidanceFailed: avoidance?.parentElement?.dataset?.failed || "",
      avoidanceComplete: avoidance?.parentElement?.dataset?.complete || "",
      checkpoints: document.querySelector("#missionCheckpointProgress")?.textContent?.trim() || "",
      returned: document.querySelector("#missionReturnProgress")?.textContent?.trim() || "",
      taskScore: document.querySelector("#competitionTaskScore")?.textContent?.trim() || "",
      ruleScore: document.querySelector("#competitionRuleScore")?.textContent?.trim() || "",
      totalScore: document.querySelector("#competitionScore")?.textContent?.trim() || "",
      replayPressed: document.querySelector("#replayRunRecordButton")?.getAttribute("aria-pressed") || "",
      editorSource: document.querySelector("#pythonEditor")?.value || "",
      pose: typeof robotPose === "object" ? { x: robotPose.x, z: robotPose.z, heading: robotPose.heading } : null
    };
  })()`, "恢复路线重置为当前 0/8", { timeoutMs: 15_000 });
  assert.equal(reset.delivery, "0/2", "重置后投放状态没有清零");
  assert.equal(reset.avoidance, "○", "重置后绕障状态没有恢复为待完成");
  assert.equal(reset.avoidanceFailed, "false", "重置后仍残留绕障 data-failed=true");
  assert.equal(reset.avoidanceComplete, "false", "重置后绕障不应完成");
  assert.equal(reset.checkpoints, "0/4", "重置后检查点状态没有清零");
  assert.equal(reset.returned, "○", "重置后返航状态没有清零");
  assert.equal(reset.missionBar, "0%", "重置后当前任务进度条没有清零");
  assert.doesNotMatch(reset.missionHint, /失败|碰撞/, "重置后当前任务提示仍残留碰撞失败");
  assert.match(reset.taskScore, /^35\.0\s*\/\s*40$/, "重置应保留上一局任务成绩供查看");
  assert.match(reset.ruleScore, /^23\.3\s*\/\s*25$/, "重置应保留上一局规则成绩供查看");
  assert.equal(reset.totalScore, "73.3", "重置应保留上一局总成绩供查看");
  assert.equal(reset.replayPressed, "false", "重置后回放按钮仍处于播放态");
  return reset;
}

async function rejectOldTaskVersionInMemory(page, diagnostics, baseline) {
  log("10/10 用缺少冻结任务的旧版本副本验证友好拦截且不污染 0/8 状态");
  const exceptionCountBefore = diagnostics.exceptions.length;
  const preparation = await page.evaluate(`(() => {
    const copy = JSON.parse(JSON.stringify(latestCompetitionRecord));
    const oldVersion = "e2e-old-task-version";
    if (Object.prototype.hasOwnProperty.call(copy, "taskVersion")) copy.taskVersion = oldVersion;
    if (copy.taskDefinition && typeof copy.taskDefinition === "object") copy.taskDefinition.version = oldVersion;
    if (copy.runDefinition?.taskDefinition && typeof copy.runDefinition.taskDefinition === "object") {
      copy.runDefinition.taskDefinition.version = oldVersion;
    }
    // A complete v4 record is intentionally replayable through its frozen map
    // even after task upgrades. Remove the frozen time limit to model an older
    // record that cannot reconstruct that mission, then exercise the explicit
    // task-version guard through the nested fallback fields.
    if (copy.runDefinition && typeof copy.runDefinition === "object") {
      delete copy.runDefinition.timeLimitTicks;
    }
    delete copy.taskVersion;
    latestCompetitionRecord = copy;
    globalThis.__e2eReplayPlayerBeforeOldTaskGuard = replayPlayer;
    return {
      nestedVersion: copy.runDefinition?.taskDefinition?.version || copy.taskDefinition?.version || "",
      replayRunning,
      pose: { x: robotPose.x, z: robotPose.z, heading: robotPose.heading }
    };
  })()`);
  assert.equal(preparation.nestedVersion, "e2e-old-task-version", "未构造出旧任务版本记录副本");
  assert.equal(preparation.replayRunning, false, "旧任务版本测试前仍在回放");

  await page.click("#replayRunRecordButton");
  const rejected = await page.waitForValue(`(() => {
    const action = document.querySelector("#competitionRecordActionStatus");
    const button = document.querySelector("#replayRunRecordButton");
    if (action?.dataset?.action !== "replay" || action?.dataset?.status !== "warning") return null;
    return {
      text: action.textContent?.trim() || "",
      statusText: document.querySelector("#appStatusToast")?.textContent?.trim() || "",
      disabled: Boolean(button?.disabled),
      busy: button?.getAttribute("aria-busy") || "",
      pressed: button?.getAttribute("aria-pressed") || "",
      replayRunning,
      samePlayer: replayPlayer === globalThis.__e2eReplayPlayerBeforeOldTaskGuard,
      missionValue: document.querySelector("#missionProgressValue")?.textContent?.trim() || "",
      missionBar: document.querySelector("#missionProgressBar")?.style?.width || "",
      delivery: document.querySelector("#missionDeliveryProgress")?.textContent?.trim() || "",
      avoidance: document.querySelector("#missionAvoidanceProgress")?.textContent?.trim() || "",
      avoidanceFailed: document.querySelector("#missionAvoidanceProgress")?.parentElement?.dataset?.failed || "",
      checkpoints: document.querySelector("#missionCheckpointProgress")?.textContent?.trim() || "",
      returned: document.querySelector("#missionReturnProgress")?.textContent?.trim() || "",
      editorSource: document.querySelector("#pythonEditor")?.value || "",
      pose: { x: robotPose.x, z: robotPose.z, heading: robotPose.heading }
    };
  })()`, "旧任务版本回放友好拦截", { timeoutMs: 10_000, intervalMs: 20 });
  assert.match(rejected.text, /任务版本与当前任务不一致/, "旧任务版本没有给出明确拦截原因");
  assert.match(rejected.statusText, /旧版任务规则|不能直接回放/, "顶部状态没有给出友好旧版本提示");
  assert.equal(rejected.disabled, false, "旧版本拦截后回放按钮没有恢复可用");
  assert.equal(rejected.busy, "false", "旧版本拦截后回放按钮仍处于 busy");
  assert.equal(rejected.pressed, "false", "旧版本拦截后回放按钮仍处于播放态");
  assert.equal(rejected.replayRunning, false, "旧版本拦截后错误启动了回放");
  assert.equal(rejected.samePlayer, true, "旧版本拦截后仍构造了新的 ReplayPlayer");
  assert.equal(rejected.missionValue, "0/8", "旧版本拦截污染了当前 0/8 进度");
  assert.equal(rejected.missionBar, "0%", "旧版本拦截污染了当前任务进度条");
  assert.equal(rejected.delivery, "0/2", "旧版本拦截污染了投放状态");
  assert.equal(rejected.avoidance, "○", "旧版本拦截污染了绕障状态");
  assert.equal(rejected.avoidanceFailed, "false", "旧版本拦截重新带回失败状态");
  assert.equal(rejected.checkpoints, "0/4", "旧版本拦截污染了检查点状态");
  assert.equal(rejected.returned, "○", "旧版本拦截污染了返航状态");
  assert.equal(rejected.editorSource, baseline.editorSource, "旧版本拦截改写了编辑器代码");
  assert.deepEqual(rejected.pose, baseline.pose, "旧版本拦截移动了已重置的小车");
  await delay(300);
  assert.equal(diagnostics.exceptions.length, exceptionCountBefore, "旧版本拦截产生了未捕获异常");
}

function assertHealthyDiagnostics(diagnostics, origin, {
  allowBatchTeamProbe = false,
  allowRankedAttemptConflict = false
} = {}) {
  const consoleErrors = diagnostics.console.filter(entry => entry.type === "error");
  const isExpectedUnauthenticatedProbe = entry => {
    try {
      const url = new URL(entry.url);
      return url.origin === origin
        && url.pathname === "/api/v1/auth/me"
        && Number(entry.status) === 401;
    } catch (_error) {
      return false;
    }
  };
  const isExpectedBrowserFavicon = entry => {
    try {
      const url = new URL(entry.url);
      return url.origin === origin
        && url.pathname === "/favicon.ico"
        && Number(entry.status) === 404;
    } catch (_error) {
      return false;
    }
  };
  const isExpectedBatchTeamProbe = entry => {
    if (!allowBatchTeamProbe) return false;
    try {
      const url = new URL(entry.url);
      return url.origin === origin
        && /^\/api\/v1\/evaluation-batches\/bat_[a-f0-9]{32}\/current-slot\/lease$/.test(url.pathname)
        && Number(entry.status) === 400;
    } catch (_error) {
      return false;
    }
  };
  const isExpectedRankedAttemptConflict = entry => {
    if (!allowRankedAttemptConflict) return false;
    try {
      const url = new URL(entry.url);
      return url.origin === origin
        && url.pathname === RANKED_EVALUATION_PATH
        && Number(entry.status) === 409;
    } catch (_error) {
      return false;
    }
  };
  const expectedAuthResponses = diagnostics.httpErrors.filter(isExpectedUnauthenticatedProbe);
  const expectedBatchTeamResponses = diagnostics.httpErrors.filter(isExpectedBatchTeamProbe);
  const expectedRankedConflictResponses = diagnostics.httpErrors.filter(isExpectedRankedAttemptConflict);
  const logErrors = diagnostics.logs.filter(entry => {
    if (entry.level !== "error") return false;
    const status = /status of (\d+)/i.exec(entry.text || "")?.[1];
    const comparable = { ...entry, status: Number(status) };
    return !isExpectedUnauthenticatedProbe(comparable)
      && !isExpectedBrowserFavicon(comparable)
      && !isExpectedBatchTeamProbe(comparable)
      && !isExpectedRankedAttemptConflict(comparable);
  });
  const unexpectedHttp = diagnostics.httpErrors.filter(entry => {
    return !isExpectedUnauthenticatedProbe(entry)
      && !isExpectedBrowserFavicon(entry)
      && !isExpectedBatchTeamProbe(entry)
      && !isExpectedRankedAttemptConflict(entry);
  });
  const unexpectedNetwork = diagnostics.networkFailures.filter(entry => (
    !entry.canceled && !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(entry.errorText || "")
  ));
  const externalRequests = diagnostics.requests.filter(entry => {
    if (/^(?:blob:|data:|about:)/.test(entry.url)) return false;
    try {
      return new URL(entry.url).origin !== origin;
    } catch (_error) {
      return true;
    }
  });
  assert.equal(expectedAuthResponses.length, 1, "登录门禁阶段应且只应出现一次未登录身份探测 401");
  assert.equal(
    expectedBatchTeamResponses.length,
    allowBatchTeamProbe ? 1 : 0,
    allowBatchTeamProbe
      ? "同源幂等兼容流程应且只应出现一次首局无队伍编号探测 400"
      : "普通流程不应出现五局无队伍编号探测 400"
  );
  assert.equal(
    expectedRankedConflictResponses.length,
    allowRankedAttemptConflict ? 1 : 0,
    allowRankedAttemptConflict
      ? "同账号第二份不同源码和队伍应且只应出现一次 409"
      : "普通流程不应出现筛选唯一机会冲突 409"
  );
  assert.deepEqual(diagnostics.exceptions, [], "页面出现未捕获 JavaScript 异常");
  assert.deepEqual(consoleErrors, [], "页面 console.error 不为空");
  assert.deepEqual(logErrors, [], "浏览器 Log.error 不为空");
  assert.deepEqual(unexpectedHttp, [], "页面资源或 API 返回 HTTP 错误");
  assert.deepEqual(unexpectedNetwork, [], "页面存在未预期的网络失败");
  assert.deepEqual(diagnostics.crashes, [], "浏览器页面或渲染进程崩溃");
  assert.deepEqual(diagnostics.dialogs, [], "测试流程出现未预期的浏览器对话框");
  assert.deepEqual(externalRequests, [], "本地仿真页面发起了外部网络请求");
}

async function captureTrainingVisionFailureEvidence(
  page,
  artifactDir,
  frameFileName = "training-vision-frame.png"
) {
  const evidence = await page.evaluate(`(() => {
    const preview = document.querySelector("#trainingVisionCanvas");
    if (!(preview instanceof HTMLCanvasElement) || !preview.width || !preview.height) {
      return { available: false };
    }
    const modelSize = 640;
    const sourceWidth = 640;
    const sourceHeight = 480;
    const model = document.createElement("canvas");
    model.width = modelSize;
    model.height = modelSize;
    const context = model.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#000";
    context.fillRect(0, 0, modelSize, modelSize);
    context.drawImage(preview, 0, 0, preview.width, preview.height, 0, 80, sourceWidth, sourceHeight);
    const rgba = context.getImageData(0, 0, modelSize, modelSize).data;
    const clamp = value => Math.min(1, Math.max(0, value));
    for (let offset = 0; offset < rgba.length; offset += 4) {
      rgba[offset] = Math.round(clamp(((rgba[offset] - 128) * 1.12 + 128) / 255) * 255);
      rgba[offset + 1] = Math.round(clamp(((rgba[offset + 1] - 128) * 1.12 + 128) / 255) * 255);
      rgba[offset + 2] = Math.round(clamp(((rgba[offset + 2] - 128) * 1.12 + 128) / 255) * 255);
    }
    const targetPixel = (red, green, blue) => (
      red >= 52 && green <= 86 && blue <= 92
      && red - green >= 30 && red - blue >= 26 && red >= green * 1.5 && red >= blue * 1.38
    );
    const brightTargetSeed = (red, green, blue) => (
      red >= 100 && green <= 92 && blue <= 96
      && red - green >= 55 && red - blue >= 48 && red >= green * 1.55 && red >= blue * 1.45
    );
    const distractorPixel = (red, green, blue) => (
      blue >= 62 && blue - green >= 22 && blue >= green * 1.25
      && (blue - red >= 30 || (red >= 48 && blue >= red * 1.15))
    );
    const brightDistractorSeed = (red, green, blue) => (
      blue >= 135 && blue - green >= 45 && blue >= green * 1.45
      && (blue - red >= 42 || (red >= 75 && blue >= red * 1.18))
    );
    const looseBlue = (red, green, blue) => (
      blue >= 48 && blue - green >= 12 && blue >= green * 1.12 && blue - red >= 12
    );
    const greenZonePixel = (red, green, blue) => (
      green >= 90 && green - red >= 24 && green - blue >= 16
      && green >= red * 1.22 && green >= blue * 1.16
    );
    const orangeZonePixel = (red, green, blue) => (
      red >= 135 && green >= 55 && green <= red * 0.82 && blue <= 105
      && red - green >= 35 && green - blue >= 12
    );
    const findRegions = (predicate, seedPredicate) => {
      const step = 2;
      const width = modelSize / step;
      const height = modelSize / step;
      const mask = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const pixelX = x * step + 1;
          const pixelY = y * step + 1;
          const offset = (pixelY * modelSize + pixelX) * 4;
          if (predicate(rgba[offset], rgba[offset + 1], rgba[offset + 2])) mask[y * width + x] = 1;
        }
      }
      const queue = new Int32Array(width * height);
      const regions = [];
      for (let start = 0; start < mask.length; start += 1) {
        if (!mask[start]) continue;
        mask[start] = 0;
        let head = 0;
        let tail = 0;
        let count = 0;
        let seedCount = 0;
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;
        let sumRed = 0;
        let sumGreen = 0;
        let sumBlue = 0;
        let minimumRed = 255;
        let minimumGreen = 255;
        let minimumBlue = 255;
        let maximumRed = 0;
        let maximumGreen = 0;
        let maximumBlue = 0;
        queue[tail++] = start;
        while (head < tail) {
          const index = queue[head++];
          const x = index % width;
          const y = Math.floor(index / width);
          const pixelX = x * step + 1;
          const pixelY = y * step + 1;
          const offset = (pixelY * modelSize + pixelX) * 4;
          const red = rgba[offset];
          const green = rgba[offset + 1];
          const blue = rgba[offset + 2];
          count += 1;
          if (seedPredicate(red, green, blue)) seedCount += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          sumRed += red;
          sumGreen += green;
          sumBlue += blue;
          minimumRed = Math.min(minimumRed, red);
          minimumGreen = Math.min(minimumGreen, green);
          minimumBlue = Math.min(minimumBlue, blue);
          maximumRed = Math.max(maximumRed, red);
          maximumGreen = Math.max(maximumGreen, green);
          maximumBlue = Math.max(maximumBlue, blue);
          for (const pair of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nextX = x + pair[0];
            const nextY = y + pair[1];
            if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
            const next = nextY * width + nextX;
            if (!mask[next]) continue;
            mask[next] = 0;
            queue[tail++] = next;
          }
        }
        const boxWidth = (maxX - minX + 1) * step;
        const boxHeight = (maxY - minY + 1) * step;
        const coverage = count / Math.max(1, boxWidth / step * (boxHeight / step));
        const ratio = boxWidth / Math.max(1, boxHeight);
        const boxX = minX * step;
        const boxY = minY * step;
        regions.push({
          box: { x: boxX, y: boxY, width: boxWidth, height: boxHeight },
          count,
          seedCount,
          seedRequired: Math.max(6, count * 0.015),
          coverage: Number(coverage.toFixed(4)),
          ratio: Number(ratio.toFixed(4)),
          contentBoundary: {
            top: boxY <= 84,
            bottom: boxY + boxHeight >= 556,
            left: boxX <= 4,
            right: boxX + boxWidth >= 636
          },
          compact: boxWidth >= 12 && boxHeight >= 12 && boxWidth * boxHeight >= 120
            && ratio >= 0.45 && ratio <= 2.2 && coverage >= 0.18,
          averageRgb: [Math.round(sumRed / count), Math.round(sumGreen / count), Math.round(sumBlue / count)],
          minimumRgb: [minimumRed, minimumGreen, minimumBlue],
          maximumRgb: [maximumRed, maximumGreen, maximumBlue]
        });
      }
      return regions.sort((left, right) => (
        right.count * right.coverage - left.count * left.coverage
      )).slice(0, 12);
    };
    return {
      available: true,
      preview: { width: preview.width, height: preview.height },
      frameId: document.querySelector("#trainingVisionWorkbench")?.dataset.frameId || "",
      sceneId: document.querySelector("#trainingVisionWorkbench")?.dataset.sceneId || "",
      renderedCategories: [...document.querySelectorAll("#trainingVisionOverlay [data-vision-box]")]
        .map(element => element.dataset.category || ""),
      carVisionStatus: window.CarVision?.getStatus?.() || null,
      carVisionDetections: (window.CarVision?.getDetections?.() || []).map(item => ({
        category: item.category,
        label: item.label,
        confidence: item.confidence,
        frameId: item.frameId,
        box: item.box
      })),
      redStrictRegions: findRegions(brightTargetSeed, brightTargetSeed),
      redLooseRegions: findRegions(targetPixel, brightTargetSeed),
      blueStrictRegions: findRegions(brightDistractorSeed, brightDistractorSeed),
      blueLooseRegions: findRegions(distractorPixel, brightDistractorSeed),
      blueDiagnosticLooseRegions: findRegions(looseBlue, brightDistractorSeed),
      greenZoneRegions: findRegions(greenZonePixel, () => false),
      orangeZoneRegions: findRegions(orangeZonePixel, () => false),
      pngDataUrl: preview.toDataURL("image/png")
    };
  })()`);
  const pngDataUrl = String(evidence?.pngDataUrl || "");
  if (pngDataUrl.startsWith("data:image/png;base64,")) {
    await fsPromises.writeFile(
      path.join(artifactDir, frameFileName),
      Buffer.from(pngDataUrl.slice("data:image/png;base64,".length), "base64")
    );
  }
  if (evidence && typeof evidence === "object") delete evidence.pngDataUrl;
  return evidence;
}

async function writeFailureArtifacts(page, artifactDir, diagnostics, error, browserInfo, browserStderr) {
  await fsPromises.mkdir(artifactDir, { recursive: true });
  let pageState = { unavailable: true };
  if (page) {
    try {
      pageState = await page.evaluate(`(() => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText: (document.body?.innerText || "").slice(0, 12000),
        pythonFeedback: document.querySelector("#pythonFeedback")?.textContent?.trim() || "",
        pythonOutput: document.querySelector("#pythonOutputContent")?.textContent?.slice(-12000) || "",
        actionLogTail: [...document.querySelectorAll("#actionLog .log-text")]
          .slice(-120).map(item => item.textContent?.trim() || ""),
        competitionRunState: document.querySelector("#competitionRunState")?.textContent?.trim() || "",
        competitionScore: document.querySelector("#competitionScore")?.textContent?.trim() || "",
        missionProgress: document.querySelector("#missionProgressValue")?.textContent?.trim() || ""
      }))()`);
    } catch (captureError) {
      pageState = { captureError: captureError.message || String(captureError) };
    }
    try {
      await page.screenshot(path.join(artifactDir, "failure.png"));
    } catch (captureError) {
      diagnostics.screenshotError = captureError.message || String(captureError);
    }
    try {
      diagnostics.trainingVision = await captureTrainingVisionFailureEvidence(page, artifactDir);
    } catch (captureError) {
      diagnostics.trainingVisionCaptureError = captureError.message || String(captureError);
    }
  }
  const report = {
    schemaVersion: "chenlong.browser-e2e-failure/v1",
    generatedAt: new Date().toISOString(),
    error: {
      message: error?.message || String(error),
      stack: error?.stack || null
    },
    browser: browserInfo,
    page: pageState,
    browserStderr: boundedTail(browserStderr),
    diagnostics
  };
  await fsPromises.writeFile(
    path.join(artifactDir, "diagnostics.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
}

async function removeSuccessfulTempRoot(tempRoot) {
  const resolved = path.resolve(tempRoot);
  const expectedRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.ok(resolved.startsWith(expectedRoot), "拒绝清理系统临时目录之外的路径");
  assert.match(path.basename(resolved), /^chenlong-browser-e2e-[A-Za-z0-9_-]+$/, "拒绝清理名称异常的目录");
  await fsPromises.rm(resolved, { recursive: true, force: true });
}

async function main() {
  requiredNodeVersion();
  const deviceScaleFactor = configuredDeviceScaleFactor();
  const executable = resolveBrowserExecutable();
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), E2E_PREFIX));
  const dataDir = path.join(tempRoot, "runtime");
  const profileDir = path.join(tempRoot, "browser-profile");
  const downloadsDir = path.join(tempRoot, "downloads");
  const artifactDir = path.join(tempRoot, "artifacts");
  await Promise.all([
    fsPromises.mkdir(dataDir, { recursive: true }),
    fsPromises.mkdir(profileDir, { recursive: true }),
    fsPromises.mkdir(downloadsDir, { recursive: true })
  ]);

  const diagnostics = {
    origin: null,
    console: [],
    logs: [],
    exceptions: [],
    httpErrors: [],
    networkFailures: [],
    requests: [],
    crashes: [],
    dialogs: [],
    transportErrors: []
  };
  const stderrState = { value: "" };
  let server = null;
  let browserProcess = null;
  let connection = null;
  let page = null;
  let browserInfo = null;
  let succeeded = false;

  try {
    const startedServer = await startServer(dataDir);
    server = startedServer.server;
    const origin = startedServer.origin;
    const health = await fetch(`${origin}/api/health`).then(response => response.json());
    assert.equal(health.status, "ok", "测试后端健康检查失败");
    assert.equal(health.authoritative, false);

    log(`启动隔离后端 ${origin}`);
    const startedBrowser = await startBrowser(executable, profileDir, stderrState, deviceScaleFactor);
    browserProcess = startedBrowser.browserProcess;
    connection = new CdpConnection(startedBrowser.webSocketUrl);
    await connection.connect();
    browserInfo = await connection.send("Browser.getVersion");
    log(`使用 ${browserInfo.product || path.basename(executable)}（Node ${process.versions.node}，DPR ${deviceScaleFactor}）`);
    page = await createPage(connection, origin, downloadsDir, diagnostics);

    const unique = `${Date.now().toString(36)}${process.pid.toString(36)}`.slice(-20);
    const credentials = {
      username: `e2e${unique}`.slice(0, 30),
      password: `E2E-Password-${unique}!`,
      displayName: "浏览器 E2E 测试队",
      teamName: "浏览器 E2E 测试队",
      group: "primary"
    };
    await registerAndEnter(page, origin, credentials, {
      dataDir,
      pinDefaultChallengeOne: FULL_GUANGYANG_MODE || GUANGYANG_RECOVERY_MODE
        || process.env.CHENLONG_E2E_PIN_DEFAULT_MAP === "1"
    });
    const actualDeviceScaleFactor = await page.evaluate("window.devicePixelRatio");
    assertNear(actualDeviceScaleFactor, deviceScaleFactor, 0.01, "浏览器实际 DPR 与测试配置不一致");
    if (RANKED_SMOKE_MODE) {
      const rankedRun = await runRankedEvaluationSmoke(page, diagnostics, credentials);
      assertHealthyDiagnostics(diagnostics, origin, { allowRankedAttemptConflict: true });
      succeeded = true;
      log(
        `通过：真人二次确认后自动完成 5 个 ranked verified/valid 当前局，` +
        `最终第 ${rankedRun.finalState.rank} 名、${rankedRun.finalState.summary.batchScore.toFixed(2)} / 100；` +
        "普通与练习提交均为 0，刷新仅通过 /me 恢复锁定源码和截止且未自动运行"
      );
    } else if (BATCH_SMOKE_MODE) {
      const batchRun = await runBatchEvaluationSmoke(page, connection, origin, downloadsDir, diagnostics);
      assertHealthyDiagnostics(diagnostics, origin, { allowBatchTeamProbe: true });
      succeeded = true;
      log(
        `通过：一次点击自动完成 5 个 verified/valid 当前局，` +
        `均分 ${batchRun.finalState.summary.meanScore.toFixed(2)}、最低分 ` +
        `${batchRun.finalState.summary.minScore.toFixed(2)}、70/30 总分 ` +
        `${batchRun.finalState.summary.batchScore.toFixed(2)} / 100；` +
        "空 sessionStorage 的 owner discovery 未自动运行，遗失批次已显式关闭"
      );
    } else {
    await testRealCarPlanBeforeDispatch(page, diagnostics);
    const requestStartIndex = diagnostics.requests.length;
    const competitionRun = GUANGYANG_RECOVERY_MODE
      ? await runGuangyangRecoveryCompetition(page)
      : FULL_GUANGYANG_MODE
        ? await runFullGuangyangCompetition(page)
        : TOPOLOGY_PLANNER_MODE
          ? await runTopologyPlannerCompetition(page)
        : { editorSource: await runCompetition(page, diagnostics), route: null };
    const editorSource = competitionRun.editorSource;
    const savedDraft = await assertAutoSavedDraftWithoutFormalSubmission(
      page,
      diagnostics,
      requestStartIndex
    );
    await expandCompetitionHudForRecordActions(page);
    await replayCurrentRecord(page, GUANGYANG_LONG_MODE ? 210_000 : 30_000, {
      recoveryGuangyang: GUANGYANG_RECOVERY_MODE
    });
    const exported = await exportRecord(page, connection, downloadsDir, {
      fullGuangyang: FULL_GUANGYANG_MODE,
      recoveryGuangyang: GUANGYANG_RECOVERY_MODE,
      topologyPlanner: TOPOLOGY_PLANNER_MODE
    });
    await verifyRecord(page, {
      expectedStatus: "verified",
      recoveryGuangyang: GUANGYANG_RECOVERY_MODE,
      topologyPlanner: TOPOLOGY_PLANNER_MODE,
      expectedVisionQueryCount: TOPOLOGY_PLANNER_MODE ? null : GUANGYANG_LONG_MODE ? 0 : 1,
      expectedNavigationQueryCount: GUANGYANG_LONG_MODE ? null : 4,
      expectedNavigationControlCount: GUANGYANG_LONG_MODE ? null : 1
    });
    await openWorkspaceRecordsAndSubmitSavedRow(
      page,
      diagnostics,
      exported.record,
      savedDraft,
      editorSource,
      requestStartIndex,
      { expectedStatus: "verified" }
    );
    await replayArchivedRecordAfterReload(page, diagnostics, GUANGYANG_LONG_MODE ? 210_000 : 45_000, {
      recoveryGuangyang: GUANGYANG_RECOVERY_MODE,
      expectedEditorSource: editorSource
    });
    if (GUANGYANG_RECOVERY_MODE) {
      const resetState = await resetRecoveryMissionState(page);
      await rejectOldTaskVersionInMemory(page, diagnostics, resetState);
    }
    if (!GUANGYANG_LONG_MODE) {
      const formalGuangyangIdentity = await testThreeObjectTraining(page, diagnostics);
      await returnToCompetitionAndCheckTrainingVisionHidden(page, formalGuangyangIdentity);
    }
    assertHealthyDiagnostics(diagnostics, origin);

    succeeded = true;
    if (GUANGYANG_RECOVERY_MODE) {
      log(`通过：广阳岛指定障碍碰撞后恢复 7/8、verified 不合格存档、双回放失败态、重置与旧任务版本拦截均正常（${exported.record.runId}）`);
    } else if (FULL_GUANGYANG_MODE) {
      log(`通过：广阳岛 8/8、两类正式图像素识别、无违规避障、verified 存档与双回放均正常（${exported.record.runId}）`);
    } else {
      log(`通过：比赛记录闭环、导航传感器复算、场景对象像素训练、摄像头视觉台与“示例”菜单三份参考程序均正常（${exported.record.runId}）`);
    }
    }
  } catch (error) {
    try {
      await writeFailureArtifacts(page, artifactDir, diagnostics, error, browserInfo, stderrState.value);
    } catch (artifactError) {
      process.stderr.write(`[browser-e2e] 失败诊断写入失败：${artifactError.stack || artifactError}\n`);
    }
    process.stderr.write(`[browser-e2e] 失败：${error.stack || error}\n`);
    process.stderr.write(`[browser-e2e] 诊断目录：${artifactDir}\n`);
    process.exitCode = 1;
  } finally {
    await stopBrowser(browserProcess, connection);
    await stopServer(server);
    if (succeeded) {
      try {
        await removeSuccessfulTempRoot(tempRoot);
      } catch (cleanupError) {
        process.stderr.write(`[browser-e2e] 测试通过，但临时目录清理失败：${cleanupError.message || cleanupError}\n`);
        process.stderr.write(`[browser-e2e] 临时目录：${tempRoot}\n`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch(error => {
  process.stderr.write(`[browser-e2e] 启动失败：${error.stack || error}\n`);
  process.exitCode = 1;
});
