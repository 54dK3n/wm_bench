"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`测试服务启动超时：${output}`)), 10_000);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.includes('"status":"listening"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`测试服务提前退出（${code}）：${output}`));
    });
  });
}

test("standalone authentication is disabled unless explicitly enabled", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-auth-disabled-"));
  const port = 45000 + Math.floor(Math.random() * 5_000);
  const origin = `http://127.0.0.1:${port}`;
  const child = childProcess.spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      BLOCKLY_PUBLIC_ORIGIN: origin,
      BLOCKLY_DATA_DIR: dataDir,
      PLATFORM_SSO_SECRET: "",
      BLOCKLY_ENABLE_LOCAL_AUTH: "",
      BLOCKLY_BOOTSTRAP_ADMIN_USERNAME: "disabled_admin",
      BLOCKLY_BOOTSTRAP_ADMIN_PASSWORD: "Disabled-Admin-12345"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForListening(child);
    const healthResponse = await fetch(`${origin}/api/health`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(health.authentication.mode, "disabled");

    for (const [route, body] of [
      ["/api/auth/login", { username: "disabled_admin", password: "Disabled-Admin-12345" }],
      ["/api/auth/register", {
        username: "disabled_user",
        password: "Disabled-User-12345",
        teamAction: "create",
        teamName: "默认禁用认证队"
      }],
      ["/api/auth/logout", {}]
    ]) {
      const response = await fetch(`${origin}${route}`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      assert.equal(response.status, 403, `${route} 默认必须禁用`);
      assert.equal(payload.error.code, "LOCAL_AUTH_DISABLED");
      assert.equal(response.headers.get("set-cookie"), null);
    }

    const meResponse = await fetch(`${origin}/api/auth/me`, {
      headers: { Cookie: `chenlong_blockly_session=${"a".repeat(43)}` }
    });
    const me = await meResponse.json();
    assert.equal(meResponse.status, 401);
    assert.equal(me.error.code, "LOCAL_AUTH_DISABLED");

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "primary-blockly-store.json"), "utf8"));
    assert.deepEqual(stored.users, [], "未显式启用时不得根据 bootstrap 环境变量创建管理员");
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("production server source contains no built-in administrator credential", () => {
  const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.doesNotMatch(source, /const\s+BOOTSTRAP_ADMIN_(?:USERNAME|PASSWORD)\s*=\s*["'][^"']+["']/);
  assert.match(source, /process\.env\.BLOCKLY_BOOTSTRAP_ADMIN_USERNAME\s*\|\|\s*["']["']/);
  assert.match(source, /process\.env\.BLOCKLY_BOOTSTRAP_ADMIN_PASSWORD\s*\|\|\s*["']["']/);
  assert.match(source, /BLOCKLY_ENABLE_LOCAL_AUTH/);
  assert.match(source, /BLOCKLY_BOOTSTRAP_ADMIN_USERNAME/);
  assert.match(source, /BLOCKLY_BOOTSTRAP_ADMIN_PASSWORD/);
});
