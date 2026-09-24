#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!fs.existsSync(chromePath)) throw new Error(`找不到 Chrome：${chromePath}`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-browser-data-"));
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-browser-profile-"));
const appPort = 36000 + Math.floor(Math.random() * 5000);
const debugPort = 41000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${appPort}`;
const stamp = Date.now().toString(36);
const username = `e2e_${stamp}`;
const password = `Browser-${stamp}-12345`;
const adminUsername = `e2e_admin_${stamp}`;
const adminPassword = `Browser-Admin-${stamp}-12345`;
const teamName = `浏览器验收队${stamp.toUpperCase()}`;
let server = null;
let chrome = null;
let client = null;

const EXPECTED_TOOLBOX_CATEGORIES = Object.freeze([
  "小车移动", "物品操作", "顺序与选择", "循环", "基础传感", "导航传感", "道路控制",
  "摄像头感知", "数据与列表", "等待与输出", "数学与逻辑", "文本", "变量", "函数"
]);
const DYNAMIC_BLOCK_TYPES = Object.freeze([
  "variables_get", "variables_set", "math_change",
  "procedures_defnoreturn", "procedures_defreturn", "procedures_callnoreturn",
  "procedures_callreturn", "procedures_ifreturn"
]);
const RUNTIME_CATEGORY_NAMES = Object.freeze([...EXPECTED_TOOLBOX_CATEGORIES]);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2000)]);
  }
}

function removeOwnedTempDirectory(directory, prefix) {
  const resolved = path.resolve(directory);
  const expectedRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(expectedRoot) || path.basename(resolved).startsWith(prefix) === false) {
    throw new Error(`拒绝清理非测试临时目录：${resolved}`);
  }
  try {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  } catch (error) {
    process.stderr.write(`警告：测试已完成，但临时目录稍后由系统清理：${resolved}（${error.code || error.message}）\n`);
  }
}

async function waitFor(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      if (error?.fatal) throw error;
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ""}`);
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  close() { this.socket.close(); }
}

async function startServer() {
  server = childProcess.spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(appPort),
      BLOCKLY_PUBLIC_ORIGIN: origin,
      BLOCKLY_DATA_DIR: dataDir,
      PLATFORM_SSO_SECRET: "",
      BLOCKLY_ENABLE_LOCAL_AUTH: "true",
      BLOCKLY_BOOTSTRAP_ADMIN_USERNAME: adminUsername,
      BLOCKLY_BOOTSTRAP_ADMIN_PASSWORD: adminPassword
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  server.stdout.on("data", chunk => { output += String(chunk); });
  server.stderr.on("data", chunk => { output += String(chunk); });
  await waitFor(() => output.includes('"status":"listening"'), "测试服务启动", 10000);
}

async function startChrome() {
  chrome = childProcess.spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--enable-unsafe-swiftshader", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, "about:blank"
  ], { stdio: "ignore" });
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok;
  }, "Chrome 调试端口", 10000);
  const tabResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${origin}/login.html`)}`, { method: "PUT" });
  const tab = await tabResponse.json();
  client = new CdpClient(tab.webSocketDebuggerUrl);
  await client.open();
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await waitFor(() => client.evaluate("document.readyState === 'complete' && document.title.includes('登录 · 广阳岛 Blockly')"), "登录页加载");
}

async function collectGenerationMatrix() {
  return client.evaluate(`(() => {
    const workspace = Blockly.getMainWorkspace();
    const toolbox = document.querySelector("#toolbox");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const results = [];
    const templates = [...toolbox.querySelectorAll(":scope > category > block")];
    const ensureVariable = () => workspace.getVariable("矩阵变量") || workspace.createVariable("矩阵变量");
    const compile = (code, type) => {
      const source = type === "controls_flow_statements" ? "for (;;) {\\n" + code + "\\n}" : code;
      new AsyncFunction("robot", source);
    };
    templates.forEach((template, index) => {
      workspace.clear();
      const variable = ensureVariable();
      const block = Blockly.Xml.domToBlock(template.cloneNode(true), workspace);
      const variableField = block.getField("VAR");
      if (variableField) variableField.setValue(variable.getId());
      const code = Blockly.JavaScript.workspaceToCode(workspace);
      compile(code, block.type);
      results.push({
        kind: "toolbox",
        index,
        category: template.closest("category")?.getAttribute("name") || "",
        type: block.type,
        workspaceBlockCount: workspace.getAllBlocks(false).length,
        code
      });
    });

    workspace.clear();
    const dynamicXml = Blockly.utils.xml.textToDom(
      '<xml xmlns="https://developers.google.com/blockly/xml">' +
      '<variables><variable id="matrixVar">矩阵变量</variable></variables>' +
      '<block type="variables_set"><field name="VAR" id="matrixVar">矩阵变量</field><value name="VALUE"><shadow type="math_number"><field name="NUM">1</field></shadow></value><next><block type="math_change"><field name="VAR" id="matrixVar">矩阵变量</field><value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value><next><block type="text_print"><value name="TEXT"><block type="variables_get"><field name="VAR" id="matrixVar">矩阵变量</field></block></value></block></next></block></next></block>' +
      '<block type="procedures_defnoreturn" x="20" y="220"><mutation></mutation><field name="NAME">矩阵动作</field><statement name="STACK"><block type="procedures_ifreturn"><mutation value="0"></mutation><value name="CONDITION"><shadow type="logic_boolean"><field name="BOOL">FALSE</field></shadow></value></block></statement></block>' +
      '<block type="procedures_callnoreturn" x="20" y="420"><mutation name="矩阵动作"></mutation></block>' +
      '<block type="procedures_defreturn" x="320" y="220"><mutation></mutation><field name="NAME">矩阵计算</field><value name="RETURN"><shadow type="math_number"><field name="NUM">7</field></shadow></value></block>' +
      '<block type="text_print" x="320" y="420"><value name="TEXT"><block type="procedures_callreturn"><mutation name="矩阵计算"></mutation></block></value></block>' +
      '</xml>'
    );
    Blockly.Xml.domToWorkspace(dynamicXml, workspace);
    const dynamicCode = Blockly.JavaScript.workspaceToCode(workspace);
    compile(dynamicCode, "dynamic");
    const presentDynamicTypes = [...new Set(workspace.getAllBlocks(false).map(block => block.type))]
      .filter(type => ${JSON.stringify(DYNAMIC_BLOCK_TYPES)}.includes(type));
    presentDynamicTypes.forEach(type => results.push({
      kind: "dynamic",
      category: type.startsWith("procedures_") ? "函数" : "变量",
      type,
      workspaceBlockCount: workspace.getAllBlocks(false).length,
      code: dynamicCode
    }));
    workspace.clear();
    return results;
  })()`);
}

async function loadSafeCategoryProgram(categoryName) {
  return client.evaluate(`(() => {
    const categoryName = ${JSON.stringify(categoryName)};
    const workspace = Blockly.getMainWorkspace();
    workspace.clear();
    const category = [...document.querySelectorAll("#toolbox > category")]
      .find(item => item.getAttribute("name") === categoryName);
    if (!category) throw new Error("找不到积木类别：" + categoryName);
    const variable = workspace.getVariable("类别变量") || workspace.createVariable("类别变量");
    const roots = [];
    const types = [];

    const makeBlock = type => {
      const block = workspace.newBlock(type);
      block.initSvg?.();
      block.render?.();
      return block;
    };
    const connectValue = (parent, inputName, child) => {
      const input = parent.getInput(inputName);
      if (input?.connection && child.outputConnection) input.connection.connect(child.outputConnection);
    };
    const numberBlock = value => {
      const block = makeBlock("math_number");
      block.setFieldValue(String(value), "NUM");
      return block;
    };
    const textBlock = value => {
      const block = makeBlock("text");
      block.setFieldValue(String(value), "TEXT");
      return block;
    };
    const boolBlock = value => {
      const block = makeBlock("logic_boolean");
      block.setFieldValue(value ? "TRUE" : "FALSE", "BOOL");
      return block;
    };
    const emptyListBlock = () => {
      const block = makeBlock("lists_create_with");
      return block;
    };
    const setNumberInput = (block, inputName, value) => {
      const target = block.getInputTargetBlock(inputName);
      if (target?.type === "math_number") target.setFieldValue(String(value), "NUM");
      else if (!target) connectValue(block, inputName, numberBlock(value));
    };
    const setTextInput = (block, inputName, value) => {
      const target = block.getInputTargetBlock(inputName);
      if (target?.type === "text") target.setFieldValue(String(value), "TEXT");
      else if (!target) connectValue(block, inputName, textBlock(value));
    };
    const setBooleanInput = (block, inputName, value) => {
      const target = block.getInputTargetBlock(inputName);
      if (target?.type === "logic_boolean") target.setFieldValue(value ? "TRUE" : "FALSE", "BOOL");
      else if (!target) connectValue(block, inputName, boolBlock(value));
    };
    const sanitize = block => {
      const variableField = block.getField("VAR");
      if (variableField) variableField.setValue(variable.getId());
      if (block.type === "robot_move_cm") setNumberInput(block, "DISTANCE_CM", 1);
      if (block.type === "robot_turn_left_angle" || block.type === "robot_turn_right_angle") block.setFieldValue("1", "DEGREES");
      if (block.type === "robot_wait") setNumberInput(block, "SECONDS", 0);
      if (block.type === "controls_repeat_ext") setNumberInput(block, "TIMES", 1);
      if (block.type === "controls_whileUntil") setBooleanInput(block, "BOOL", block.getFieldValue("MODE") === "UNTIL");
      if (block.type === "controls_for") {
        setNumberInput(block, "FROM", 1); setNumberInput(block, "TO", 1); setNumberInput(block, "BY", 1);
      }
      if (block.type === "controls_forEach" && !block.getInputTargetBlock("LIST")) connectValue(block, "LIST", emptyListBlock());
      if (block.type === "robot_follow_road") {
        setNumberInput(block, "MAX_CM", 10); setNumberInput(block, "SPEED", 100); setBooleanInput(block, "OBEY", false);
      }
      if (block.type === "robot_take_exit") {
        setTextInput(block, "ROAD_ID", "不存在的道路"); setNumberInput(block, "SPEED", 30); setBooleanInput(block, "OBEY", false);
      }
      if (block.type === "robot_vision_approach") {
        setNumberInput(block, "DISTANCE_CM", 20); setNumberInput(block, "MAX_STEPS", 1);
      }
      if (block.type === "lists_getIndex") {
        if (!block.getInputTargetBlock("VALUE")) connectValue(block, "VALUE", emptyListBlock());
        setNumberInput(block, "AT", 1);
      }
      if (block.type === "lists_setIndex") {
        if (!block.getInputTargetBlock("LIST")) connectValue(block, "LIST", emptyListBlock());
        setNumberInput(block, "AT", 1);
        if (!block.getInputTargetBlock("TO")) connectValue(block, "TO", numberBlock(0));
      }
      return block;
    };
    const wrapReporter = block => {
      const print = makeBlock("text_print");
      connectValue(print, "TEXT", block);
      return print;
    };
    const wrapFlow = block => {
      const repeat = makeBlock("controls_repeat_ext");
      connectValue(repeat, "TIMES", numberBlock(1));
      repeat.getInput("DO").connection.connect(block.previousConnection);
      return repeat;
    };
    [...category.querySelectorAll(":scope > block")].forEach(template => {
      if (template.getAttribute("type") === "robot_forever") {
        // “持续巡逻”按设计不会自然结束，不能和类别完成标记串在一起；
        // 它的真实运行与停止由后面的独立用例覆盖。
        types.push("robot_forever");
        return;
      }
      const block = sanitize(Blockly.Xml.domToBlock(template.cloneNode(true), workspace));
      types.push(block.type);
      let root = block;
      if (block.type === "controls_flow_statements") root = wrapFlow(block);
      else if (block.outputConnection) root = wrapReporter(block);
      roots.push(root);
    });

    if (categoryName === "变量") {
      const set = makeBlock("variables_set");
      set.getField("VAR").setValue(variable.getId());
      connectValue(set, "VALUE", numberBlock(1));
      const change = makeBlock("math_change");
      change.getField("VAR").setValue(variable.getId());
      connectValue(change, "DELTA", numberBlock(1));
      const get = makeBlock("variables_get");
      get.getField("VAR").setValue(variable.getId());
      roots.push(set, change, wrapReporter(get));
      types.push("variables_set", "math_change", "variables_get");
    }

    roots.forEach((root, index) => {
      const previous = roots[index - 1];
      if (index && previous?.nextConnection && root?.previousConnection && !previous.nextConnection.isConnected()) {
        previous.nextConnection.connect(root.previousConnection);
      }
    });
    const saveTrigger = makeBlock("robot_move_cm");
    saveTrigger.setFieldValue("forward", "DIR");
    connectValue(saveTrigger, "DISTANCE_CM", numberBlock(0.1));
    const tail = [...roots].reverse().find(root => root?.nextConnection && !root.nextConnection.isConnected());
    if (tail?.nextConnection && saveTrigger.previousConnection) tail.nextConnection.connect(saveTrigger.previousConnection);
    else roots.push(saveTrigger);
    const marker = makeBlock("text_print");
    connectValue(marker, "TEXT", textBlock("E2E 类别完成：" + categoryName));
    if (saveTrigger.nextConnection && marker.previousConnection) saveTrigger.nextConnection.connect(marker.previousConnection);
    else roots.push(marker);

    const code = Blockly.JavaScript.workspaceToCode(workspace);
    new (Object.getPrototypeOf(async function () {}).constructor)("robot", code);
    return {
      categoryName,
      types: [...new Set(types)],
      topBlockCount: workspace.getTopBlocks(false).length,
      totalBlockCount: workspace.getAllBlocks(false).length,
      code
    };
  })()`);
}

async function loadFunctionProgram() {
  const xml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="procedures_defnoreturn" x="20" y="20"><mutation></mutation><field name="NAME">执行动作</field><statement name="STACK"><block type="procedures_ifreturn"><mutation value="0"></mutation><value name="CONDITION"><shadow type="logic_boolean"><field name="BOOL">FALSE</field></shadow></value><next><block type="text_print"><value name="TEXT"><shadow type="text"><field name="TEXT">函数执行</field></shadow></value><next><block type="robot_move_cm"><field name="DIR">forward</field><value name="DISTANCE_CM"><shadow type="math_number"><field name="NUM">0.1</field></shadow></value></block></next></block></next></block></statement></block><block type="procedures_callnoreturn" x="20" y="260"><mutation name="执行动作"></mutation><next><block type="text_print"><value name="TEXT"><block type="procedures_callreturn"><mutation name="计算结果"></mutation></block></value></block></next></block><block type="procedures_defreturn" x="360" y="20"><mutation></mutation><field name="NAME">计算结果</field><value name="RETURN"><shadow type="math_number"><field name="NUM">7</field></shadow></value></block></xml>';
  return client.evaluate(`(() => {
    const workspace = Blockly.getMainWorkspace();
    workspace.clear();
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(${JSON.stringify(xml)}), workspace);
    const code = Blockly.JavaScript.workspaceToCode(workspace);
    new (Object.getPrototypeOf(async function () {}).constructor)("robot", code);
    return { categoryName: "函数", types: [...new Set(workspace.getAllBlocks(false).map(block => block.type).filter(type => type.startsWith("procedures_")))], topBlockCount: workspace.getTopBlocks(false).length, totalBlockCount: workspace.getAllBlocks(false).length, code };
  })()`);
}

async function runAndSubmitCurrentProgram(categoryName) {
  const before = await client.evaluate("fetch('/api/records', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(payload=>payload.records)");
  const beforeIds = new Set(before.map(record => record.id));
  await client.evaluate("document.querySelector('#runButton').click(); true");
  try {
  await waitFor(async () => {
    const state = await client.evaluate(`Promise.all([
      fetch('/api/records', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json()),
      Promise.resolve([...document.querySelectorAll('#actionLog li')].map(item=>item.textContent)),
      Promise.resolve(Boolean(activeRun))
    ]).then(([payload, logs, active])=>({saved:payload.records?.some(record=>!${JSON.stringify([...beforeIds])}.includes(record.id)),logs,active}))`);
    if (state.saved) return true;
    const fatalLog = state.logs.find(line => /代码出错|停止：循环超过|本次成绩暂未保存/.test(line));
    if (fatalLog && !state.active) {
      const error = new Error(`${categoryName} 没有保存：${fatalLog}`);
      error.fatal = true;
      throw error;
    }
    return false;
  }, `${categoryName} 运行并保存`, 45000);
  } catch (error) {
    const diagnostic = await client.evaluate(`(() => ({
      status: document.querySelector('#statusText')?.textContent || '',
      active: Boolean(activeRun),
      runReason: activeRun?.reason || null,
      logs: [...document.querySelectorAll('#actionLog li')].map(item => item.textContent),
      code: document.querySelector('#codeOutput')?.textContent || ''
    }))()`);
    throw new Error(`${error.message}\n${categoryName} 诊断：${JSON.stringify(diagnostic)}`);
  }
  await waitFor(() => client.evaluate("!activeRun && !document.querySelector('#runButton').disabled"), `${categoryName} 运行完整结束`, 10000);
  const records = await client.evaluate("fetch('/api/records', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(payload=>payload.records)");
  const record = records.find(item => !beforeIds.has(item.id));
  assert.ok(record, `${categoryName} 没有生成运行记录`);
  assert.equal(record.recordState, "saved", `${categoryName} 新记录不是已保存状态`);
  const logText = await client.evaluate("[...document.querySelectorAll('#actionLog li')].map(item=>item.textContent).join('\\n')");
  assert.match(logText, /本次调试已保存/, `${categoryName} 缺少自动保存日志`);
  assert.doesNotMatch(logText, /程序错误|运行失败|TypeError|ReferenceError|SyntaxError/, `${categoryName} 出现运行错误`);
  const submitted = await client.evaluate(`fetch('/api/records/${record.id}/submit', {method:'POST',credentials:'same-origin',headers:{Origin:location.origin,'Content-Type':'application/json'},body:'{}'}).then(async r=>({ok:r.ok,status:r.status,payload:await r.json()}))`);
  assert.equal(submitted.ok, true, `${categoryName} 正式提交失败：${submitted.status}`);
  assert.equal(submitted.payload.record.recordState, "submitted");
  return { categoryName, recordId: record.id, score: record.score, executionTrace: record.executionTrace || [] };
}

async function runBrowserFlow() {
  assert.match(await client.evaluate("document.title"), /登录 · 广阳岛 Blockly/);
  await client.evaluate(`(() => {
    document.querySelector("#registerTab").click();
    document.querySelector("#registerTeamName").value = ${JSON.stringify(teamName)};
    document.querySelector("#registerGroup").value = "junior";
    document.querySelector("#registerUsername").value = ${JSON.stringify(username)};
    document.querySelector("#registerPassword").value = ${JSON.stringify(password)};
    document.querySelector("#registerPasswordConfirm").value = ${JSON.stringify(password)};
    document.querySelector("#registerForm").requestSubmit();
    return true;
  })()`);
  await waitFor(() => client.evaluate("Boolean(document.querySelector('#teamInviteDialog')?.open)"), "注册和邀请码弹窗");
  const inviteCode = await client.evaluate("document.querySelector('#teamInviteCodeValue').textContent");
  assert.match(inviteCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  await client.evaluate("document.querySelector('#teamInviteContinueButton').click()");
  await waitFor(() => client.evaluate(`location.pathname === "/" && document.querySelector("#accountName")?.textContent === ${JSON.stringify(username)}`), "进入 Blockly 工作区", 45000);
  await waitFor(() => client.evaluate("Boolean(globalThis.Blockly?.getMainWorkspace?.()) && !document.querySelector('#runButton').disabled"), "Blockly 与三维场景就绪", 45000);

  const taskOptions = await client.evaluate("[...document.querySelector('#sceneSelect').options].map(option => option.textContent)");
  assert.deepEqual(taskOptions, ["广阳岛综合任务1", "广阳岛综合任务2", "广阳岛综合任务3"]);
  assert.equal(await client.evaluate("document.querySelector('#primaryScoreValue').textContent"), "--");
  const frontDistanceText = await client.evaluate("document.querySelector('#frontText').textContent");
  const frontDistanceCm = Number(frontDistanceText.match(/(\d+)\s*cm/)?.[1]);
  assert.equal(Number.isFinite(frontDistanceCm) && frontDistanceCm > 0 && frontDistanceCm <= 500, true, `前方距离单位异常：${frontDistanceText}`);

  const realCameraLifecycle = await client.evaluate(`(async () => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const requests = [];
    const cameraStream = document.querySelector("#cameraStream");
    Object.defineProperty(cameraStream, "src", {
      configurable: true,
      get() { return this.dataset.e2eSrc || ""; },
      set(value) {
        this.dataset.e2eSrc = String(value);
        queueMicrotask(() => this.onload?.(new Event("load")));
      }
    });
    globalThis.fetch = async (input, init) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, location.href);
      if (url.origin === "http://192.168.4.1"
        && (url.pathname === "/api/control"
          || ["/api/camera/open", "/api/camera/close"].includes(url.pathname))) {
        requests.push(url.pathname);
        return new Response("", { status: 200 });
      }
      return originalFetch(input, init);
    };
    const target = document.querySelector("#targetSelect");
    target.value = "real";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    const deadline = Date.now() + 3000;
    while (document.querySelector("#realCameraStage")?.dataset.cameraState !== "live" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const liveState = document.querySelector("#realCameraStage")?.dataset.cameraState;
    const status = document.querySelector("#cameraStatus")?.textContent || "";
    const streamUrl = cameraStream.src;
    target.value = "sim";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch;
    delete cameraStream.dataset.e2eSrc;
    delete cameraStream.src;
    cameraStream.removeAttribute("src");
    return { liveState, status, streamUrl, requests };
  })()`);
  assert.equal(realCameraLifecycle.liveState, "live", "Blockly 实车摄像头未进入实时预览状态");
  assert.match(realCameraLifecycle.status, /仅实时预览/);
  assert.match(realCameraLifecycle.streamUrl, /^http:\/\/192\.168\.4\.1\/api\/camera\/stream\?[^#]*fps=12/);
  assert.deepEqual(realCameraLifecycle.requests.filter(pathname => pathname.startsWith("/api/camera/")), [
    "/api/camera/open", "/api/camera/close"
  ]);

  const toolbox = await client.evaluate(`(() => ({
    categories: [...document.querySelectorAll('#toolbox category')].map(category => category.getAttribute('name')),
    blockTypes: [...document.querySelectorAll('#toolbox block')].map(block => block.getAttribute('type'))
  }))()`);
  assert.deepEqual(toolbox.categories, EXPECTED_TOOLBOX_CATEGORIES);
  for (const type of ["robot_move_cm", "robot_gripper", "robot_sequence", "controls_if", "controls_repeat_ext", "controls_whileUntil", "controls_for", "controls_forEach", "robot_front_blocked", "robot_sensor_distance", "robot_on_road", "robot_holding_package", "robot_checkpoint_count", "robot_task_complete", "robot_mission", "robot_task_state", "robot_release_preview", "robot_odometry", "robot_road_state", "robot_map_graph", "robot_follow_road", "robot_take_exit", "robot_vision_observe", "robot_vision_detect", "robot_vision_approach", "robot_data_get", "robot_list_item", "text_print"]) {
    assert.equal(toolbox.blockTypes.includes(type), true, `工具箱缺少 ${type}`);
  }
  assert.equal(toolbox.blockTypes.includes("robot_move"), false, "旧版秒数移动积木不应出现在新工具箱");

  const generationMatrix = await collectGenerationMatrix();
  const toolboxMatrix = generationMatrix.filter(item => item.kind === "toolbox");
  const dynamicMatrix = generationMatrix.filter(item => item.kind === "dynamic");
  assert.equal(toolboxMatrix.length, 80, "工具箱顶层入口数量变化时必须同步严格浏览器矩阵");
  assert.equal(new Set(toolboxMatrix.map(item => item.type)).size, 73, "工具箱唯一积木类型数量变化时必须同步严格浏览器矩阵");
  assert.deepEqual([...new Set(dynamicMatrix.map(item => item.type))].sort(), [...DYNAMIC_BLOCK_TYPES].sort());
  generationMatrix.forEach(item => {
    assert.equal(typeof item.code === "string" && item.code.trim().length > 0, true, `${item.type} 没有生成代码`);
    assert.doesNotMatch(item.code, /\b(?:undefined|NaN)\b/, `${item.type} 生成了无效值`);
    assert.equal(item.workspaceBlockCount > 0, true, `${item.type} 没有实际创建积木实例`);
  });

  const runtimeContracts = await client.evaluate(`(async () => {
    if (activeRun) throw new Error("运行时边界测试开始前不应有活动程序");
    const previousRun = activeRun;
    const forbiddenKeys = new Set([
      "x", "z", "point", "points", "position", "nearestpoint", "segmentindex",
      "tangent", "tangentx", "tangentz", "worldx", "worldz", "progressworld",
      "distanceworld", "widthworld", "lengthworld"
    ]);
    const coordinateLeaks = [];
    const scanPublicData = (value, location = "result", seen = new WeakSet()) => {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((item, index) => scanPublicData(item, location + "[" + index + "]", seen));
        return;
      }
      Object.entries(value).forEach(([key, item]) => {
        if (forbiddenKeys.has(key.toLowerCase())) coordinateLeaks.push(location + "." + key);
        scanPublicData(item, location + "." + key, seen);
      });
    };
    const errorOf = async callback => {
      try {
        await callback();
        return null;
      } catch (error) {
        return { name: error?.name || "Error", message: String(error?.message || error) };
      }
    };
    const withContext = async callback => {
      const context = createRunContext("sim");
      activeRun = context;
      try {
        return await callback(makeRobotApi(context), context);
      } finally {
        if (!context.signal.aborted) abortRunContext(context, "runtime-contract-test");
        context.resolveDone();
        activeRun = previousRun;
        updateRunControls();
      }
    };

    const publicData = await withContext(async (api, context) => {
      const values = {
        mission: api.mission(),
        taskState: api.task_state(),
        releasePreview: api.release_preview(),
        odometry: api.odometry(),
        roadState: api.road_state(),
        mapGraph: api.map_graph(),
        observations: api.observe("全部", 0),
        detections: api.detect("全部", 0)
      };
      scanPublicData(values);
      return {
        values,
        trace: [...context.executedApiMethods],
        jsonLength: api.jsonText(values).length,
        firstObservation: api.listItem(values.observations, 1),
        observationCount: api.dataLength(values.observations),
        roadId: api.dataGet(values.roadState, "roadId")
      };
    });

    const invalid = await withContext(async (api, context) => {
      const cyclic = {};
      cyclic.self = cyclic;
      const errors = {
        confidenceLow: await errorOf(() => api.sees("目标物", -0.01)),
        confidenceHigh: await errorOf(() => api.observe("全部", 1.01)),
        visionTarget: await errorOf(() => api.direction("不存在", 0.5)),
        followDistance: await errorOf(() => api.follow_road(9, 40, false)),
        followSpeed: await errorOf(() => api.follow_road(10, 9, false)),
        followBoolean: await errorOf(() => api.follow_road(10, 40, "false")),
        exitId: await errorOf(() => api.take_exit("", 30, false)),
        approachDistance: await errorOf(() => api.approach("目标物", 4, 10)),
        approachSteps: await errorOf(() => api.approach("目标物", 20, 101)),
        coordinateKey: await errorOf(() => api.dataGet({ x: 1 }, "x")),
        prototypeKey: await errorOf(() => api.dataGet({}, "constructor")),
        listType: await errorOf(() => api.listItem({}, 1)),
        listIndex: await errorOf(() => api.listItem([1], 0)),
        requireList: await errorOf(() => api.requireList({})),
        cyclicJson: await errorOf(() => api.jsonText(cyclic))
      };
      return {
        errors,
        trace: [...context.executedApiMethods],
        missingListItem: api.listItem(["one"], 2),
        missingField: api.dataGet({ safe: 1 }, "missing"),
        scalarLength: api.dataLength(123)
      };
    });

    const navigationLimit = await withContext(async (api, context) => {
      for (let index = 0; index < 1000; index += 1) api.mission();
      return {
        error: await errorOf(() => api.mission()),
        count: context.navigationQueryCount,
        trace: [...context.executedApiMethods]
      };
    });
    const visionLimit = await withContext(async (api, context) => {
      for (let index = 0; index < 1000; index += 1) api.sees("目标物", 0);
      return {
        error: await errorOf(() => api.sees("目标物", 0)),
        count: context.visionQueryCount,
        trace: [...context.executedApiMethods]
      };
    });
    const roadLimit = await withContext(async (api, context) => {
      for (let index = 0; index < 300; index += 1) await api.take_exit("missing-road", 30, false);
      return {
        error: await errorOf(() => api.take_exit("missing-road", 30, false)),
        count: context.roadControlCount,
        trace: [...context.executedApiMethods]
      };
    });
    const procedureCallLimit = await withContext(async (api, context) => {
      for (let index = 0; index < 1000; index += 1) {
        await api.procedureEnter("普通函数");
        api.procedureExit();
      }
      return {
        error: await errorOf(() => api.procedureEnter("普通函数")),
        calls: context.procedureCallCount,
        depth: context.procedureCallDepth
      };
    });
    const procedureDepthLimit = await withContext(async (api, context) => {
      for (let index = 0; index < 50; index += 1) await api.procedureEnter("递归函数");
      return {
        error: await errorOf(() => api.procedureEnter("递归函数")),
        calls: context.procedureCallCount,
        depth: context.procedureCallDepth
      };
    });
    const repeatLimit = await withContext(async (api, context) => ({
      error: await errorOf(() => api.repeatLimit(101)),
      reason: context.reason
    }));
    const whileLimit = await withContext(async (api, context) => ({
      error: await errorOf(() => api.loopLimit()),
      reason: context.reason
    }));
    const loopInputLimit = await withContext(async (api, context) => ({
      error: await errorOf(() => api.loopInputError("测试中的步长为 0")),
      reason: context.reason
    }));

    resetRobot();
    const cancellation = await withContext(async (api, context) => {
      const operation = api.follow_road(500, 10, false);
      setTimeout(() => abortRunContext(context, "stopped"), 5);
      return {
        error: await errorOf(() => operation),
        reason: context.reason,
        trace: [...context.executedApiMethods]
      };
    });
    return {
      coordinateLeaks, publicData, invalid, navigationLimit, visionLimit, roadLimit,
      procedureCallLimit, procedureDepthLimit, repeatLimit, whileLimit, loopInputLimit, cancellation
    };
  })()`);
  assert.deepEqual(runtimeContracts.coordinateLeaks, [], "公开导航或视觉数据泄露了内部坐标");
  assert.deepEqual(runtimeContracts.publicData.trace, [
    "mission", "task_state", "release_preview", "odometry", "road_state", "map_graph", "observe", "detect"
  ]);
  assert.equal(runtimeContracts.publicData.jsonLength > 0, true);
  assert.equal(Number.isInteger(runtimeContracts.publicData.observationCount), true);
  assert.equal(runtimeContracts.publicData.roadId === null || typeof runtimeContracts.publicData.roadId === "string", true);

  const invalidErrors = runtimeContracts.invalid.errors;
  Object.entries(invalidErrors).forEach(([name, error]) => assert.ok(error?.message, `${name} 非法参数没有被拒绝`));
  assert.match(invalidErrors.confidenceLow.message, /0 到 1/);
  assert.match(invalidErrors.visionTarget.message, /摄像头目标/);
  assert.match(invalidErrors.followDistance.message, /10 到 500 厘米/);
  assert.match(invalidErrors.followSpeed.message, /10 到 100/);
  assert.match(invalidErrors.followBoolean.message, /必须是布尔值/);
  assert.match(invalidErrors.exitId.message, /出口道路编号/);
  assert.match(invalidErrors.approachDistance.message, /5 到 200 厘米/);
  assert.match(invalidErrors.approachSteps.message, /1 到 100/);
  assert.match(invalidErrors.coordinateKey.message, /不开放坐标/);
  assert.match(invalidErrors.listType.message, /需要连接列表数据/);
  assert.match(invalidErrors.listIndex.message, /从 1 开始/);
  assert.match(invalidErrors.cyclicJson.message, /不能转换为文字/);
  assert.deepEqual(runtimeContracts.invalid.trace, ["sees", "observe", "direction", "follow_road", "take_exit", "approach"]);
  assert.equal(runtimeContracts.invalid.missingListItem, null);
  assert.equal(runtimeContracts.invalid.missingField, null);
  assert.equal(runtimeContracts.invalid.scalarLength, 0);

  assert.equal(runtimeContracts.navigationLimit.count, 1001);
  assert.match(runtimeContracts.navigationLimit.error.message, /导航传感查询超过每次运行 1000 次/);
  assert.deepEqual(runtimeContracts.navigationLimit.trace, ["mission"]);
  assert.equal(runtimeContracts.visionLimit.count, 1001);
  assert.match(runtimeContracts.visionLimit.error.message, /摄像头查询超过每次运行 1000 次/);
  assert.deepEqual(runtimeContracts.visionLimit.trace, ["sees"]);
  assert.equal(runtimeContracts.roadLimit.count, 301);
  assert.match(runtimeContracts.roadLimit.error.message, /道路控制超过每次运行 300 次/);
  assert.deepEqual(runtimeContracts.roadLimit.trace, ["take_exit"]);
  assert.equal(runtimeContracts.procedureCallLimit.calls, 1001);
  assert.equal(runtimeContracts.procedureCallLimit.depth, 0);
  assert.equal(runtimeContracts.procedureCallLimit.error.name, "RunCancelledError");
  assert.match(runtimeContracts.procedureCallLimit.error.message, /procedure-limit/);
  assert.equal(runtimeContracts.procedureDepthLimit.calls, 51);
  assert.equal(runtimeContracts.procedureDepthLimit.depth, 50);
  assert.equal(runtimeContracts.procedureDepthLimit.error.name, "RunCancelledError");
  assert.match(runtimeContracts.procedureDepthLimit.error.message, /procedure-limit/);
  assert.equal(runtimeContracts.repeatLimit.error.name, "RunCancelledError");
  assert.equal(runtimeContracts.repeatLimit.reason, "loop-limit");
  assert.equal(runtimeContracts.whileLimit.error.name, "RunCancelledError");
  assert.equal(runtimeContracts.whileLimit.reason, "loop-limit");
  assert.equal(runtimeContracts.loopInputLimit.error.name, "RunCancelledError");
  assert.equal(runtimeContracts.loopInputLimit.reason, "loop-input-error");
  assert.equal(runtimeContracts.cancellation.error.name, "RunCancelledError");
  assert.equal(runtimeContracts.cancellation.reason, "stopped");
  assert.deepEqual(runtimeContracts.cancellation.trace, ["follow_road"]);

  const programXml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="robot_sequence" x="40" y="40"><statement name="DO"><block type="controls_repeat_ext"><value name="TIMES"><shadow type="math_number"><field name="NUM">2</field></shadow></value><statement name="DO"><block type="robot_move_cm"><field name="DIR">forward</field><value name="DISTANCE_CM"><shadow type="math_number"><field name="NUM">1</field></shadow></value></block></statement><next><block type="controls_if"><mutation else="1"></mutation><value name="IF0"><block type="robot_front_blocked"></block></value><statement name="DO0"><block type="robot_turn_right_90"></block></statement><statement name="ELSE"><block type="text_print"><value name="TEXT"><shadow type="text"><field name="TEXT">道路通畅</field></shadow></value></block></statement></block></next></block></statement></block></xml>';
  const generatedCode = await client.evaluate(`(() => {
    const xml = Blockly.utils.xml.textToDom(${JSON.stringify(programXml)});
    const workspace = Blockly.getMainWorkspace();
    workspace.clear();
    Blockly.Xml.domToWorkspace(xml, workspace);
    return Blockly.JavaScript.workspaceToCode(workspace);
  })()`);
  assert.match(generatedCode, /robot\.forward\(1\)/);
  assert.match(generatedCode, /robot\.checkFrontObstacle\(\)/);
  assert.match(generatedCode, /robot\.print\(['"]道路通畅['"]\)/);
  assert.match(generatedCode, /repeatEnd_/);
  await client.evaluate(`(() => {
    document.querySelector("#runButton").click();
    return true;
  })()`);
  await waitFor(() => client.evaluate("[...document.querySelectorAll('#actionLog li')].some(item => item.textContent.includes('本次调试已保存'))"), "运行并保存成绩", 30000);
  const movementPerformance = await client.evaluate("getRobotLabPerformance()");
  assert.equal(Math.abs(movementPerformance.trajectoryDistanceCm - 2) <= 0.2, true, `2 厘米积木实际移动了 ${movementPerformance.trajectoryDistanceCm} 厘米`);
  const records = await client.evaluate("fetch('/api/records', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json())");
  assert.equal(records.records.length, 1);
  assert.equal(records.records[0].recordState, "saved");
  assert.equal(records.records[0].mapRevision, 1);
  await waitFor(() => client.evaluate("!activeRun && !document.querySelector('#runButton').disabled"), "基础移动程序完整结束", 10000);

  const variablesFunctionsLoopsXml = `<xml xmlns="https://developers.google.com/blockly/xml">
    <variables>
      <variable id="sum_variable">总数</variable>
      <variable id="for_variable">i</variable>
      <variable id="item_variable">item</variable>
      <variable id="argument_variable">x</variable>
      <variable id="while_variable">计数器</variable>
    </variables>
    <block type="procedures_defnoreturn" x="440" y="40">
      <mutation></mutation><field name="NAME">加十</field>
      <statement name="STACK"><block type="math_change"><field name="VAR" id="sum_variable">总数</field><value name="DELTA"><shadow type="math_number"><field name="NUM">10</field></shadow></value></block></statement>
    </block>
    <block type="procedures_defreturn" x="440" y="180">
      <mutation><arg name="x" varid="argument_variable"></arg></mutation><field name="NAME">倍增</field>
      <value name="RETURN"><block type="math_arithmetic"><field name="OP">MULTIPLY</field><value name="A"><block type="variables_get"><field name="VAR" id="argument_variable">x</field></block></value><value name="B"><shadow type="math_number"><field name="NUM">2</field></shadow></value></block></value>
    </block>
    <block type="variables_set" x="40" y="40">
      <field name="VAR" id="sum_variable">总数</field><value name="VALUE"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
      <next><block type="controls_for">
        <field name="VAR" id="for_variable">i</field>
        <value name="FROM"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
        <value name="TO"><shadow type="math_number"><field name="NUM">3</field></shadow></value>
        <value name="BY"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
        <statement name="DO"><block type="math_change"><field name="VAR" id="sum_variable">总数</field><value name="DELTA"><block type="variables_get"><field name="VAR" id="for_variable">i</field></block></value></block></statement>
        <next><block type="controls_forEach">
          <field name="VAR" id="item_variable">item</field>
          <value name="LIST"><block type="lists_create_with"><mutation items="2"></mutation><value name="ADD0"><shadow type="math_number"><field name="NUM">4</field></shadow></value><value name="ADD1"><shadow type="math_number"><field name="NUM">5</field></shadow></value></block></value>
          <statement name="DO"><block type="math_change"><field name="VAR" id="sum_variable">总数</field><value name="DELTA"><block type="variables_get"><field name="VAR" id="item_variable">item</field></block></value></block></statement>
          <next><block type="procedures_callnoreturn"><mutation name="加十"></mutation>
            <next><block type="text_print"><value name="TEXT"><block type="variables_get"><field name="VAR" id="sum_variable">总数</field></block></value>
              <next><block type="text_print"><value name="TEXT"><block type="procedures_callreturn"><mutation name="倍增"><arg name="x"></arg></mutation><value name="ARG0"><shadow type="math_number"><field name="NUM">7</field></shadow></value></block></value>
                <next><block type="variables_set"><field name="VAR" id="while_variable">计数器</field><value name="VALUE"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
                  <next><block type="controls_whileUntil"><field name="MODE">WHILE</field>
                    <value name="BOOL"><block type="logic_compare"><field name="OP">LT</field><value name="A"><block type="variables_get"><field name="VAR" id="while_variable">计数器</field></block></value><value name="B"><shadow type="math_number"><field name="NUM">3</field></shadow></value></block></value>
                    <statement name="DO"><block type="math_change"><field name="VAR" id="while_variable">计数器</field><value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value></block></statement>
                    <next><block type="text_print"><value name="TEXT"><block type="variables_get"><field name="VAR" id="while_variable">计数器</field></block></value></block></next>
                  </block></next>
                </block></next>
              </block></next>
            </block></next>
          </block></next>
        </block></next>
      </block></next>
    </block>
  </xml>`;
  const variablesFunctionsLoopsCode = await client.evaluate(`(() => {
    const workspace = Blockly.getMainWorkspace();
    workspace.clear();
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(${JSON.stringify(variablesFunctionsLoopsXml)}), workspace);
    return Blockly.JavaScript.workspaceToCode(workspace);
  })()`);
  assert.match(variablesFunctionsLoopsCode, /async function/);
  assert.match(variablesFunctionsLoopsCode, /await robot\.loopTick\("计数循环"/);
  assert.match(variablesFunctionsLoopsCode, /await robot\.loopTick\("遍历列表"/);
  assert.match(variablesFunctionsLoopsCode, /await robot\.loopTick\("当条件成立时重复"/);
  assert.match(variablesFunctionsLoopsCode, /robot\.procedureEnter/);
  assert.match(variablesFunctionsLoopsCode, /robot\.procedureExit/);
  assert.match(variablesFunctionsLoopsCode, /await [^(]+\(\)/);
  await client.evaluate("document.querySelector('#runButton').click()");
  await waitFor(() => client.evaluate("[...document.querySelectorAll('#actionLog li')].some(item => item.textContent.includes('输出：3'))"), "变量、函数和三类循环运行", 30000);
  assert.equal(await client.evaluate("[...document.querySelectorAll('#actionLog li')].some(item => item.textContent.includes('输出：25'))"), true, "计数和列表循环结果错误");
  assert.equal(await client.evaluate("[...document.querySelectorAll('#actionLog li')].some(item => item.textContent.includes('输出：14'))"), true, "带参数和返回值的函数结果错误");
  await waitFor(() => client.evaluate("!activeRun && !document.querySelector('#runButton').disabled"), "变量、函数和循环程序完整结束", 10000);
  const recordsAfterDataProgram = await client.evaluate("fetch('/api/records', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json())");
  assert.equal(recordsAfterDataProgram.records.length, 1, "只有数据运算和输出、不含小车动作的程序不应误存比赛记录");

  const foreverProgramXml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="robot_forever" x="40" y="40"><statement name="DO"><block type="robot_wait"><value name="SECONDS"><shadow type="math_number"><field name="NUM">0.05</field></shadow></value></block></statement></block></xml>';
  const foreverCode = await client.evaluate(`(() => {
    const workspace = Blockly.getMainWorkspace();
    workspace.clear();
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(${JSON.stringify(foreverProgramXml)}), workspace);
    return Blockly.JavaScript.workspaceToCode(workspace);
  })()`);
  assert.match(foreverCode, /for \(let patrol_/);
  assert.match(foreverCode, /!robot\.stopped\(\)/);
  await client.evaluate("document.querySelector('#runButton').click()");
  await waitFor(() => client.evaluate("[...document.querySelectorAll('#actionLog li')].some(item => item.textContent.includes('持续巡逻：第 1 次'))"), "持续循环开始运行", 30000);
  await client.evaluate("document.querySelector('#stopButton').click()");
  await waitFor(() => client.evaluate("document.querySelector('#statusText').textContent === '程序已停止' && !document.querySelector('#runButton').disabled"), "停止持续循环", 30000);
  const recordsAfterStoppedForever = await client.evaluate("fetch('/api/records', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json())");
  assert.equal(recordsAfterStoppedForever.records.length, 1, "手动停止的持续循环不应误存比赛记录");

  await client.evaluate("document.querySelector('#recordsButton').click()");
  await waitFor(() => client.evaluate("Boolean(document.querySelector('#recordsDialog')?.open)"), "我的成绩弹窗");
  await waitFor(() => client.evaluate("document.querySelector('#recordsSummary').textContent.includes('已保存 1 条调试记录')"), "成绩列表读取");
  assert.match(await client.evaluate("document.querySelector('#recordsSummary').textContent"), /已保存 1 条调试记录/);
  assert.match(await client.evaluate("document.querySelector('#recordsList').textContent"), /推荐提交/);
  await client.evaluate("document.querySelector('#recordsList .primary-record-actions button.primary').click()");
  await waitFor(() => client.evaluate("document.querySelector('#recordsSummary').textContent.includes('已正式提交 1 条')"), "正式提交成绩");
  assert.match(await client.evaluate("document.querySelector('#recordsList').textContent"), /已提交/);
  await client.evaluate("document.querySelector('#recordsDialog').close()");

  const capabilityProgramXml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="text_print" x="40" y="40"><value name="TEXT"><block type="robot_mission"></block></value><next><block type="text_print"><value name="TEXT"><block type="robot_road_state"></block></value><next><block type="text_print"><value name="TEXT"><block type="robot_vision_observe"><field name="TARGET">全部</field><value name="CONFIDENCE"><shadow type="math_number"><field name="NUM">0.1</field></shadow></value></block></value><next><block type="robot_follow_road"><value name="MAX_CM"><shadow type="math_number"><field name="NUM">10</field></shadow></value><value name="SPEED"><shadow type="math_number"><field name="NUM">100</field></shadow></value><value name="OBEY"><shadow type="logic_boolean"><field name="BOOL">FALSE</field></shadow></value></block></next></block></next></block></next></block></xml>';
  const capabilityCode = await client.evaluate(`(() => {
    const workspace = Blockly.getMainWorkspace();
    workspace.clear();
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(${JSON.stringify(capabilityProgramXml)}), workspace);
    return Blockly.JavaScript.workspaceToCode(workspace);
  })()`);
  assert.match(capabilityCode, /robot\.mission\(\)/);
  assert.match(capabilityCode, /robot\.road_state\(\)/);
  assert.match(capabilityCode, /robot\.observe\("全部", 0\.1\)/);
  assert.match(capabilityCode, /robot\.follow_road\(10, 100, false\)/);
  await client.evaluate("document.querySelector('#runButton').click()");
  await waitFor(() => client.evaluate("fetch('/api/records', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(payload=>payload.records?.length === 2)"), "运行导航与感知积木并保存第二条记录", 30000);
  await waitFor(() => client.evaluate("!activeRun && !document.querySelector('#runButton').disabled"), "导航与感知程序完整结束", 10000);
  const capabilityRecords = await client.evaluate("fetch('/api/records', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json())");
  assert.equal(capabilityRecords.records.length, 2);
  const capabilityRecord = capabilityRecords.records.find(record => record.capabilityUsage?.navigationSensorMethods?.length && record.capabilityUsage?.roadControlMethods?.length && record.capabilityUsage?.visionMethods?.length);
  assert.ok(capabilityRecord, "没有保存导航、道路控制和摄像头能力标记");
  assert.deepEqual(capabilityRecord.executionTrace, ["road_state", "mission", "follow_road", "observe"]);
  const submitCapability = await client.evaluate(`fetch('/api/records/${capabilityRecord.id}/submit', {method:'POST',credentials:'same-origin',headers:{Origin:location.origin,'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())`);
  assert.equal(submitCapability.record.recordState, "submitted");

  const runtimePrograms = [];
  const runtimeResults = [];
  for (const categoryName of RUNTIME_CATEGORY_NAMES.filter(name => name !== "函数")) {
    const program = await loadSafeCategoryProgram(categoryName);
    const expectedTypes = generationMatrix.filter(item => item.category === categoryName).map(item => item.type);
    for (const type of new Set(expectedTypes)) {
      assert.equal(program.types.includes(type), true, `${categoryName} 运行组合缺少 ${type}`);
    }
    assert.equal(program.code.includes(`E2E 类别完成：${categoryName}`), true, `${categoryName} 运行组合缺少完成标记`);
    runtimePrograms.push(program);
    runtimeResults.push(await runAndSubmitCurrentProgram(categoryName));
  }
  const functionProgram = await loadFunctionProgram();
  for (const type of DYNAMIC_BLOCK_TYPES.filter(type => type.startsWith("procedures_"))) {
    assert.equal(functionProgram.types.includes(type), true, `函数运行组合缺少 ${type}`);
  }
  runtimePrograms.push(functionProgram);
  runtimeResults.push(await runAndSubmitCurrentProgram("函数"));
  assert.deepEqual(runtimeResults.map(item => item.categoryName), RUNTIME_CATEGORY_NAMES);

  const submittedRecords = await client.evaluate("fetch('/api/records', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json()).then(payload=>payload.records.filter(record=>record.recordState==='submitted'))");
  assert.equal(submittedRecords.length, 16, "两条基础验收记录和十四类积木记录都应正式提交");

  await client.evaluate(`(() => {
    const select = document.querySelector("#sceneSelect");
    select.value = "guangyang2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await waitFor(() => client.evaluate("document.querySelector('#missionTitle').textContent === '广阳岛综合任务2'"), "切换第二项任务");
  assert.match(await client.evaluate("document.querySelector('#missionText').textContent"), /6 个途径点/);

  await client.evaluate("document.querySelector('#logoutButton').click()");
  await waitFor(() => client.evaluate("location.pathname.endsWith('/login.html')"), "退出登录");
  await waitFor(() => client.evaluate("Boolean(document.querySelector('#loginUsername') && document.querySelector('#loginPassword') && document.querySelector('#loginForm'))"), "登录表单重新载入");
  await client.evaluate(`(() => {
    document.querySelector("#loginUsername").value = ${JSON.stringify(adminUsername)};
    document.querySelector("#loginPassword").value = ${JSON.stringify(adminPassword)};
    document.querySelector("#loginForm").requestSubmit();
    return true;
  })()`);
  await waitFor(() => client.evaluate("location.pathname.endsWith('/admin.html') && document.title.includes('管理后台')"), "管理员后台", 30000);
  await waitFor(() => client.evaluate("document.querySelector('#adminRecordCount').textContent === '16'"), "管理员数据读取");
  assert.equal(await client.evaluate("document.querySelector('#adminRecordsBody').textContent.includes('浏览器验收队')"), true);
  assert.equal(await client.evaluate("document.querySelector('#adminRecordsBody').textContent.includes('初中组')"), true);
  assert.equal(await client.evaluate(`(() => {
    const filter = document.querySelector('#adminRecordGroupFilter');
    filter.value = 'primary';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    const primaryHidden = !document.querySelector('#adminRecordsBody').textContent.includes(${JSON.stringify(teamName)});
    filter.value = 'junior';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    return primaryHidden && document.querySelector('#adminRecordsBody').textContent.includes(${JSON.stringify(teamName)});
  })()`), true, "后台小组筛选必须按三组制生效");
  assert.equal(await client.evaluate("document.querySelector('#adminRecordsBody').textContent.includes('导航传感') && document.querySelector('#adminRecordsBody').textContent.includes('道路控制') && document.querySelector('#adminRecordsBody').textContent.includes('摄像头感知')"), true);
  const adminCapabilityDetail = await client.evaluate(`fetch('/api/admin/records/${capabilityRecord.id}', {credentials:'same-origin',cache:'no-store'}).then(r=>r.json())`);
  assert.equal(adminCapabilityDetail.record.id, capabilityRecord.id);
  assert.match(adminCapabilityDetail.record.programCode, /robot\.follow_road\(10, 100, false\)/);
  assert.deepEqual(adminCapabilityDetail.record.executionTrace, capabilityRecord.executionTrace);
  await client.evaluate(`(() => {
    for (let page = 0; page < 5; page++) {
      const row = [...document.querySelectorAll('#adminRecordsBody tr')].find(item =>
        item.textContent.includes('导航传感') && item.textContent.includes('道路控制') && item.textContent.includes('摄像头感知'));
      if (row) {
        row.querySelector('button').click();
        return true;
      }
      const next = document.querySelector('#adminRecordsNext');
      if (!next || next.disabled) break;
      next.click();
    }
    throw new Error('管理员分页中没有能力组合记录');
  })()`);
  await waitFor(() => client.evaluate("Boolean(document.querySelector('#adminRecordDialog')?.open) && document.querySelector('#adminRecordProgramCode').textContent.includes('robot.follow_road(10, 100, false)')"), "管理员查看积木代码和能力标记");
  assert.equal(await client.evaluate("document.querySelector('#adminRecordCapabilities').textContent.includes('mission') && document.querySelector('#adminRecordCapabilities').textContent.includes('follow_road') && document.querySelector('#adminRecordCapabilities').textContent.includes('observe')"), true);
  await client.evaluate("document.querySelector('#adminRecordDialog').close(); document.querySelector('[data-admin-tab=\"maps\"]').click()");
  await waitFor(() => client.evaluate("!document.querySelector('[data-admin-panel=\"maps\"]').hidden && document.querySelectorAll('.primary-admin-map-marker').length === 8"), "地图编辑器任务一");
  await client.evaluate(`(() => {
    const select = document.querySelector("#adminMapTask");
    select.value = "GYI-PRIMARY-03";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await waitFor(() => client.evaluate("document.querySelectorAll('.primary-admin-map-marker').length === 18"), "地图编辑器任务三");
  assert.match(await client.evaluate("document.querySelector('#adminMapRevision').textContent"), /当前修订 1/);
  return {
    inviteCode,
    submittedRecordId: records.records[0].id,
    capabilityRecordId: capabilityRecord.id,
    generationMatrixEntries: generationMatrix.length,
    toolboxEntries: toolboxMatrix.length,
    uniqueToolboxTypes: new Set(toolboxMatrix.map(item => item.type)).size,
    dynamicBlockTypes: dynamicMatrix.length,
    runtimeCategories: runtimeResults.length,
    runtimeRecords: runtimeResults,
    adminMapMarkersTask3: 18
  };
}

(async () => {
  try {
    await startServer();
    await startChrome();
    const result = await runBrowserFlow();
    process.stdout.write(`${JSON.stringify({ ok: true, username, teamName, ...result }, null, 2)}\n`);
  } finally {
    client?.close();
    await Promise.all([stopChild(chrome), stopChild(server)]);
    removeOwnedTempDirectory(dataDir, "blockly-browser-data-");
    removeOwnedTempDirectory(profileDir, "blockly-browser-profile-");
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
