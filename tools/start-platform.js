#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const contract = require("../packages/platform-contract.js");

const PLATFORM_ROOT = path.resolve(__dirname, "..");
const PROJECTS_ROOT = path.join(PLATFORM_ROOT, "projects");
const PYTHON_ROOT = path.join(PROJECTS_ROOT, "car-python");
const BLOCKLY_ROOT = path.join(PROJECTS_ROOT, "blockly-page3");
const WORKSHOP_ROOT = path.join(PROJECTS_ROOT, "tmm");
const DATA_ROOT = path.join(PLATFORM_ROOT, "data");
const SECRET_PATH = path.join(DATA_ROOT, "platform-sso-secret.txt");
const PYTHON_WRITER_LOCK = path.join(PYTHON_ROOT, ".runtime", ".chenlong-writer.lock");
const VINEXT_CLI = path.join("node_modules", "vinext", "dist", "cli.js");
const VITE_CLI = path.join("node_modules", "vite", "bin", "vite.js");
const WORKSHOP_RUNTIME_CONFIG = path.join(WORKSHOP_ROOT, "dist", "server", "wrangler.json");
const INTERNAL_HOST = "127.0.0.1";
const ALLOWED_GATEWAY_BIND_HOSTS = new Set(["127.0.0.1", "0.0.0.0", "::1", "::"]);
const FEDERATION_PROBE_ADMIN = Object.freeze({
  id: "usr_ffffffffffffffffffffffffffffffff",
  username: "platform_probe_admin",
  displayName: "平台探针",
  role: "admin",
  teamId: null,
  teamName: null,
  group: null,
  createdAt: "2026-08-28T00:00:00.000Z"
});
const PROJECTS = Object.freeze([
  { name: "Python", cwd: PYTHON_ROOT, port: 6178, health: "/api/health", marker: "chenlong.backend-health/v1", command: process.execPath, args: ["server.js"], internalScoreSource: true },
  { name: "Blockly", cwd: BLOCKLY_ROOT, port: 6180, health: "/api/health", marker: "chenlong.blockly-health/v1", command: process.execPath, args: ["server.js"], federated: true },
  {
    name: "识物工坊",
    cwd: WORKSHOP_ROOT,
    port: 3000,
    health: "/api/competition/health",
    marker: "workshop-competition",
    prepare: { command: process.execPath, args: [VINEXT_CLI, "build"] },
    command: process.execPath,
    args: [VITE_CLI, "preview", "--host", "127.0.0.1", "--port", "3000", "--strictPort"],
    federated: true
  },
  { name: "统一网关", cwd: PLATFORM_ROOT, port: 6190, health: "/api/health", marker: "chenlong-competition-platform", command: process.execPath, args: ["server.js"], gateway: true }
]);

function persistentSecret(secretPath = SECRET_PATH) {
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (Buffer.byteLength(existing, "utf8") < 32) throw new Error("持久化的平台密钥长度不足，请人工移走该文件后重试。");
    return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const created = crypto.randomBytes(48).toString("base64url");
  try {
    fs.writeFileSync(secretPath, `${created}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return created;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (Buffer.byteLength(existing, "utf8") < 32) throw new Error("持久化的平台密钥长度不足。");
    return existing;
  }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function archiveStalePythonLock(lockPath = PYTHON_WRITER_LOCK) {
  let value;
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096) {
      throw new Error("Python 写入锁文件格式不安全，请人工检查。 ");
    }
    value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (value?.schemaVersion !== "chenlong.data-directory-writer-lock/v1"
    || !Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw new Error("Python 写入锁文件内容无效，请人工检查。 ");
  }
  if (processExists(value.pid)) return null;
  const archived = `${lockPath}.stale-${value.pid}-${Date.now()}`;
  fs.renameSync(lockPath, archived);
  return archived;
}

function probe(project, timeoutMs = 1_200) {
  return new Promise(resolve => {
    const request = http.get({ hostname: "127.0.0.1", port: project.port, path: project.health, timeout: timeoutMs }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ reachable: true, healthy: response.statusCode >= 200 && response.statusCode < 500 && body.includes(project.marker), statusCode: response.statusCode, body });
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ reachable: false, healthy: false, statusCode: null, body: "" }));
  });
}

function federationKeyId(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);
}

function requestProbe(port, requestPath, headers = {}, timeoutMs = 5_000) {
  return new Promise(resolve => {
    const request = http.get({ hostname: "127.0.0.1", port, path: requestPath, headers, timeout: timeoutMs }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ statusCode: 0, body: "" }));
  });
}

async function federationProbe(project, secret) {
  if (project.gateway) {
    const result = await requestProbe(project.port, "/api/health");
    try {
      return result.statusCode === 200
        && JSON.parse(result.body).federationKeyId === federationKeyId(secret);
    } catch {
      return false;
    }
  }
  if (project.name === "Blockly") {
    const principal = contract.signPrincipal(secret, "blockly", FEDERATION_PROBE_ADMIN);
    const result = await requestProbe(project.port, "/api/auth/me", {
      [contract.PRINCIPAL_HEADER]: principal,
      Accept: "application/json"
    });
    try {
      const payload = JSON.parse(result.body);
      return result.statusCode === 200 && payload?.user?.username === FEDERATION_PROBE_ADMIN.username;
    } catch {
      return false;
    }
  }
  if (project.name === "识物工坊") {
    const principal = contract.signPrincipal(secret, "workshop", FEDERATION_PROBE_ADMIN);
    const result = await requestProbe(project.port, "/api/competition/admin/session", {
      [contract.PRINCIPAL_HEADER]: principal,
      Accept: "application/json"
    }, 15_000);
    try {
      const payload = JSON.parse(result.body);
      return result.statusCode === 200 && payload?.authenticated === true
        && payload?.user?.username === FEDERATION_PROBE_ADMIN.username;
    } catch {
      return false;
    }
  }
  return true;
}

function normalizedLaunchOrigin(value, name) {
  if (value === undefined || value === null || value === "") return null;
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch (_error) {
    throw new Error(`${name} 必须是有效的 HTTP(S) Origin。`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} 只能包含协议、主机和端口。`);
  }
  return parsed.origin;
}

function normalizedGatewayBindHost(value) {
  if (value === undefined || value === null || String(value).trim() === "") return INTERNAL_HOST;
  const host = String(value).trim();
  if (!ALLOWED_GATEWAY_BIND_HOSTS.has(host)) {
    throw new Error("CHENLONG_PLATFORM_BIND_HOST 只允许使用回环地址或通配监听地址。 ");
  }
  return host;
}

function environmentFor(project, secret, sourceEnvironment = process.env) {
  const env = {
    ...sourceEnvironment,
    HOST: project.gateway
      ? normalizedGatewayBindHost(sourceEnvironment.CHENLONG_PLATFORM_BIND_HOST)
      : INTERNAL_HOST,
    PORT: String(project.port)
  };
  const platformOrigin = normalizedLaunchOrigin(
    env.CHENLONG_PLATFORM_PUBLIC_ORIGIN,
    "CHENLONG_PLATFORM_PUBLIC_ORIGIN"
  );
  if (project.federated) env.PLATFORM_SSO_SECRET = secret;
  if (project.internalScoreSource) env.CHENLONG_PLATFORM_SSO_SECRET = secret;
  if (project.gateway) env.CHENLONG_PLATFORM_SSO_SECRET = secret;
  if (project.name === "Blockly") {
    const explicitBlocklyOrigin = normalizedLaunchOrigin(env.BLOCKLY_PUBLIC_ORIGIN, "BLOCKLY_PUBLIC_ORIGIN");
    if (platformOrigin && explicitBlocklyOrigin && platformOrigin !== explicitBlocklyOrigin) {
      throw new Error("统一平台与 Blockly 公网 Origin 配置不一致。 ");
    }
    if (platformOrigin || explicitBlocklyOrigin) {
      env.BLOCKLY_PUBLIC_ORIGIN = platformOrigin || explicitBlocklyOrigin;
    }
  }
  if (project.internalScoreSource) {
    const explicitPythonOrigin = normalizedLaunchOrigin(env.CHENLONG_PUBLIC_ORIGIN, "CHENLONG_PUBLIC_ORIGIN");
    if (platformOrigin && explicitPythonOrigin && platformOrigin !== explicitPythonOrigin) {
      throw new Error("统一平台与 Python 公网 Origin 配置不一致。 ");
    }
    const publicOrigin = platformOrigin || explicitPythonOrigin;
    if (publicOrigin) env.CHENLONG_PUBLIC_ORIGIN = publicOrigin;
    if (publicOrigin?.startsWith("https://")) env.CHENLONG_SECURE_COOKIES = "true";
    const officialSsoEnabled = typeof env.CHENLONG_OFFICIAL_SSO_SECRET === "string"
      && env.CHENLONG_OFFICIAL_SSO_SECRET.length > 0;
    const insecureTestMode = env.CHENLONG_OFFICIAL_SSO_ALLOW_INSECURE_TEST_MODE === "true";
    if (officialSsoEnabled && !insecureTestMode
      && (!publicOrigin?.startsWith("https://") || env.CHENLONG_SECURE_COOKIES !== "true")) {
      throw new Error(
        "官网 SSO 已启用，必须配置 HTTPS 的 CHENLONG_PLATFORM_PUBLIC_ORIGIN；"
        + "启动器会同步 Python Origin 并启用 Secure Cookie。"
      );
    }
  }
  return env;
}

function launch(project, secret) {
  if (!fs.existsSync(project.cwd)) throw new Error(`${project.name}项目目录不存在：${project.cwd}`);
  const child = spawn(project.command, project.args, {
    cwd: project.cwd,
    env: environmentFor(project, secret),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", chunk => process.stdout.write(`[${project.name}] ${chunk}`));
  child.stderr.on("data", chunk => process.stderr.write(`[${project.name}] ${chunk}`));
  return child;
}

function injectWorkshopRuntimeSecret(secret, configPath = WORKSHOP_RUNTIME_CONFIG) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("识物工坊运行密钥长度不足。 ");
  }
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024) {
    throw new Error("识物工坊运行配置文件格式不安全。 ");
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length < 1
    || !Array.isArray(config.r2_buckets) || config.r2_buckets.length < 1) {
    throw new Error("识物工坊运行配置缺少 D1 或 R2 绑定。 ");
  }
  config.vars = { ...(config.vars || {}), PLATFORM_SSO_SECRET: secret };
  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporaryPath, configPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function prepareProject(project, secret) {
  if (!project.prepare) return Promise.resolve();
  if (process.env.CHENLONG_WORKSHOP_SKIP_BUILD === "true") {
    if (project.name !== "识物工坊") throw new Error(`${project.name}不支持跳过构建。`);
    injectWorkshopRuntimeSecret(secret);
    return Promise.resolve();
  }
  const child = spawn(project.prepare.command, project.prepare.args, {
    cwd: project.cwd,
    env: environmentFor(project, secret),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", chunk => process.stdout.write(`[${project.name} 构建] ${chunk}`));
  child.stderr.on("data", chunk => process.stderr.write(`[${project.name} 构建] ${chunk}`));
  return new Promise((resolve, reject) => {
    child.once("error", error => reject(new Error(`${project.name}构建无法启动：${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
      reject(new Error(`${project.name}构建失败（${reason}）。`));
    });
  });
}

async function waitHealthy(project, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${project.name}启动进程提前退出（${child.exitCode}）。`);
    const result = await probe(project);
    if (result.healthy) return;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error(`${project.name}未能在 ${Math.ceil(timeoutMs / 1000)} 秒内通过健康检查。`);
}

async function waitFederationHealthy(project, secret, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${project.name}启动进程提前退出（${child.exitCode}）。`);
    if (await federationProbe(project, secret)) return;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error(`${project.name}启动后未通过统一身份联邦检查。`);
}

async function startAll() {
  const secret = persistentSecret();
  const children = [];
  try {
    for (const project of PROJECTS) {
      const current = await probe(project);
      if (current.reachable) {
        if (!current.healthy) throw new Error(`${project.port} 端口已被其他服务占用，未执行覆盖或强制结束。`);
        if ((project.federated || project.gateway) && !await federationProbe(project, secret)) {
          throw new Error(`${project.name}已运行，但没有使用当前统一平台密钥，请先停止该旧服务后重试。`);
        }
        process.stdout.write(`[${project.name}] 已运行，健康检查通过。\n`);
        continue;
      }
      if (project.name === "Python") archiveStalePythonLock();
      await prepareProject(project, secret);
      const child = launch(project, secret);
      children.push({ project, child });
      await waitHealthy(project, child);
      if (project.federated || project.gateway) {
        await waitFederationHealthy(project, secret, child);
      }
      process.stdout.write(`[${project.name}] 已启动：http://127.0.0.1:${project.port}/\n`);
    }
  } catch (error) {
    children.forEach(({ child }) => { if (child.exitCode === null) child.kill("SIGTERM"); });
    await Promise.all(children.map(({ child }) => child.exitCode !== null
      ? Promise.resolve()
      : new Promise(resolve => child.once("exit", resolve))));
    archiveStalePythonLock();
    throw error;
  }
  process.stdout.write("统一平台已就绪：http://127.0.0.1:6190/\n");
  if (!children.length) return;
  const stop = () => children.forEach(({ child }) => { if (child.exitCode === null) child.kill("SIGTERM"); });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await Promise.all(children.map(({ child }) => new Promise(resolve => child.once("exit", resolve))));
  archiveStalePythonLock();
}

if (require.main === module) {
  startAll().catch(error => {
    process.stderr.write(`统一平台启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PLATFORM_ROOT,
  PROJECTS_ROOT,
  PROJECTS,
  persistentSecret,
  archiveStalePythonLock,
  federationKeyId,
  federationProbe,
  waitFederationHealthy,
  probe,
  normalizedLaunchOrigin,
  normalizedGatewayBindHost,
  injectWorkshopRuntimeSecret,
  environmentFor
};
