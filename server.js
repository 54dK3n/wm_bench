#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { URL } = require("node:url");

const contract = require("./packages/platform-contract.js");
const officialScores = require("./packages/score-download.js");
const liveScores = require("./packages/live-score-source.js");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 6190;
const DEFAULT_UPSTREAMS = Object.freeze({
  python: "http://127.0.0.1:6178",
  blockly: "http://127.0.0.1:6180",
  workshop: "http://127.0.0.1:3000"
});
const DEFAULT_AUTH_STORE = path.join(__dirname, "projects", "car-python", ".runtime", "auth", "auth-store.json");
const PLATFORM_SCHEMA_VERSION = "chenlong.competition-platform/v1";
const PLATFORM_READINESS_SCHEMA_VERSION = "chenlong.competition-platform-readiness/v1";
const ADMIN_OVERVIEW_SCHEMA_VERSION = "chenlong.platform-admin-overview/v1";
const PERSONAL_SCORES_SCHEMA_VERSION = "chenlong.platform-personal-scores/v1";
const MAPS_SCHEMA_VERSION = "chenlong.blockly-maps/v1";
const MAX_PROXY_BODY_BYTES = 48 * 1024 * 1024;
const MAX_AUTH_PROXY_BODY_BYTES = 16 * 1024;
const MAX_AUTH_STORE_BYTES = 8 * 1024 * 1024;
const STATIC_STREAM_PATH_PATTERN = /\.(?:wasm|zip|onnx|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i;
const TEXT_STATIC_PATH_PATTERN = /\.(?:js|css)$/i;
const ADMIN_PAGE_SIZE = 15;
const READINESS_TIMEOUT_MS = 2_500;
const TASKS = Object.freeze(["task1", "task2", "task3"]);
const PARTICIPANT_GROUP_LABELS = Object.freeze({
  primary: "小学组",
  junior: "初中组",
  high: "高中组"
});
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Bound fan-out to each local child service during large refresh/login waves.
// Excess work waits in the agent and completed sockets are reused.
const UPSTREAM_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxSockets: 128,
  maxFreeSockets: 32,
  scheduling: "lifo"
});
// Vinext serves the workshop through Vite in the integrated local launcher.
// Its rendered HTML intentionally uses root-relative development asset URLs.
// Keep this list narrow: notably, /@fs is excluded so the public gateway can
// never become a generic filesystem proxy.
const WORKSHOP_ASSET_PREFIXES = Object.freeze([
  "/@id/",
  "/@vite/",
  "/node_modules/",
  "/app/",
  "/components/",
  "/lib/"
]);
const WORKSHOP_ASSET_PATHS = new Set([
  "/@react-refresh",
  "/favicon.svg",
  "/file.svg",
  "/globe.svg",
  "/og.png",
  "/window.svg"
]);
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"
]);
// External proxy metadata describes the browser-to-gateway hop, not the
// gateway-to-local-service hop.  Forwarding it makes frameworks reconstruct a
// public HTTPS URL while receiving a loopback HTTP Origin.  The one endpoint
// that needs the client IP (official SSO) receives a separately normalized
// x-forwarded-for value after this filter.
const EXTERNAL_PROXY_HEADERS = new Set([
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-port",
  "x-forwarded-proto", "cf-connecting-ip", "cf-visitor"
]);

class PlatformHttpError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.name = "PlatformHttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

function positivePort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("platform port must be an integer between 0 and 65535");
  }
  return port;
}

function normalizedUpstream(value, fallback) {
  const parsed = new URL(value || fallback);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("platform upstream must be one plain HTTP origin");
  }
  return parsed.origin;
}

function normalizedPublicOrigin(value) {
  if (!value) return null;
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("platform public origin must be one HTTP(S) origin");
  }
  return parsed.origin;
}

function normalizedIp(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (candidate.startsWith("[") && candidate.endsWith("]")) candidate = candidate.slice(1, -1);
  const zone = candidate.indexOf("%");
  if (zone >= 0) candidate = candidate.slice(0, zone);
  if (candidate.toLowerCase().startsWith("::ffff:") && net.isIP(candidate.slice(7)) === 4) {
    candidate = candidate.slice(7);
  }
  return net.isIP(candidate) ? candidate.toLowerCase() : null;
}

function normalizedTrustedProxyIps(value) {
  if (value === undefined || value === null || value === "") return new Set();
  const source = value instanceof Set
    ? [...value]
    : Array.isArray(value)
      ? value
      : String(value).split(",");
  const result = new Set();
  for (const item of source) {
    const ip = normalizedIp(String(item));
    if (!ip) throw new TypeError("trusted proxy list must contain exact IP addresses");
    result.add(ip);
  }
  return result;
}

function singleRequestHeader(request, name) {
  const lower = name.toLowerCase();
  if (Array.isArray(request.rawHeaders)) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === lower) count += 1;
    }
    if (count > 1) return null;
  }
  const value = request.headers?.[lower];
  return typeof value === "string" ? value.trim() : null;
}

function clientIpForRequest(request, trustedProxyIps) {
  const direct = normalizedIp(request.socket?.remoteAddress);
  if (!direct) return "unknown";
  if (!trustedProxyIps.has(direct)) return direct;
  const cloudflare = singleRequestHeader(request, "CF-Connecting-IP");
  const cloudflareIp = cloudflare && !cloudflare.includes(",") ? normalizedIp(cloudflare) : null;
  if (cloudflareIp) return cloudflareIp;
  const forwarded = singleRequestHeader(request, "X-Forwarded-For");
  const firstForwarded = forwarded ? normalizedIp(forwarded.split(",", 1)[0]) : null;
  return firstForwarded || direct;
}

function platformSecret(value) {
  const secret = value || process.env.CHENLONG_PLATFORM_SSO_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("CHENLONG_PLATFORM_SSO_SECRET must contain at least 32 UTF-8 bytes");
  }
  return secret;
}

function jsonBody(response, statusCode, payload, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(body);
}

function platformError(code, message) {
  return {
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    authoritative: false,
    error: { code, message }
  };
}

function requestExternalOrigin(request, configuredOrigin = null) {
  if (configuredOrigin) return configuredOrigin;
  const host = request.headers.host;
  if (!host) throw new PlatformHttpError(400, "INVALID_HOST", "请求主机信息不完整。");
  const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim();
  const protocol = forwarded === "https" ? "https:" : "http:";
  try {
    return new URL(`${protocol}//${host}`).origin;
  } catch (_error) {
    throw new PlatformHttpError(400, "INVALID_HOST", "请求主机信息无效。");
  }
}

function assertExternalOrigin(request, configuredOrigin = null) {
  if (!WRITE_METHODS.has(request.method || "GET")) return;
  const supplied = request.headers.origin;
  // Non-browser administration tools may omit Origin. Browser writes always
  // send it and are checked before any bytes are forwarded upstream.
  if (supplied === undefined) return;
  let normalized;
  try {
    normalized = new URL(String(supplied)).origin;
  } catch (_error) {
    throw new PlatformHttpError(403, "CROSS_ORIGIN_REQUEST", "请求来源不受信任，请刷新页面后重试。");
  }
  if (normalized !== requestExternalOrigin(request, configuredOrigin)) {
    throw new PlatformHttpError(403, "CROSS_ORIGIN_REQUEST", "请求来源不受信任，请刷新页面后重试。");
  }
}

function safePathname(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    throw new PlatformHttpError(400, "INVALID_PATH", "请求路径编码无效。");
  }
}

function isWorkshopAssetPath(pathname) {
  return WORKSHOP_ASSET_PATHS.has(pathname)
    || WORKSHOP_ASSET_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml"
  })[extension] || "application/octet-stream";
}

function textAssetCacheControl(pathname, searchParams) {
  if (!TEXT_STATIC_PATH_PATTERN.test(pathname)) return "no-store, max-age=0";
  return searchParams?.get("v")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=3600, must-revalidate";
}

function assetEtag(data) {
  return `"${crypto.createHash("sha256").update(data).digest("base64url")}"`;
}

function servePublic(request, response, publicDir, pathname) {
  const routes = new Map([
    ["/", "portal.html"],
    ["/portal.html", "portal.html"],
    ["/login.html", "login.html"],
    ["/admin.html", "admin.html"],
    ["/platform.css", "platform.css"],
    ["/portal.css", "portal.css"],
    ["/admin.css", "admin.css"],
    ["/platform-login.js", "platform-login.js"],
    ["/platform-portal.js", "platform-portal.js"],
    ["/platform-admin.js", "platform-admin.js"]
  ]);
  const relative = routes.get(pathname);
  if (!relative) return false;
  const filePath = path.join(publicDir, relative);
  const data = fs.readFileSync(filePath);
  const cacheControl = TEXT_STATIC_PATH_PATTERN.test(pathname)
    ? "public, max-age=300, must-revalidate"
    : "no-store, max-age=0";
  const etag = assetEtag(data);
  const headers = {
    "Content-Type": mimeType(filePath),
    "Content-Length": data.length,
    "Cache-Control": cacheControl,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'"
  };
  if (request.headers["if-none-match"] === etag && ["GET", "HEAD"].includes(request.method || "GET")) {
    delete headers["Content-Length"];
    response.writeHead(304, headers);
    response.end();
    return true;
  }
  response.writeHead(200, headers);
  if (request.method === "HEAD") response.end();
  else response.end(data);
  return true;
}

const authStoreCache = new Map();
const authStoreUserIndexes = new WeakMap();

function authStoreUserIndex(authStore) {
  let index = authStoreUserIndexes.get(authStore);
  if (!index) {
    index = new Map(authStore.users.map(user => [user.id, user]));
    authStoreUserIndexes.set(authStore, index);
  }
  return index;
}

function readAuthStore(authStorePath) {
  let stat;
  try {
    stat = fs.lstatSync(authStorePath);
  } catch (_error) {
    throw new PlatformHttpError(503, "AUTH_STORE_UNAVAILABLE", "统一账户数据暂时不可读取。");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_AUTH_STORE_BYTES) {
    throw new PlatformHttpError(503, "AUTH_STORE_UNAVAILABLE", "统一账户数据格式不安全。");
  }
  const cached = authStoreCache.get(authStorePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(authStorePath, "utf8"));
  } catch (_error) {
    throw new PlatformHttpError(503, "AUTH_STORE_UNAVAILABLE", "统一账户数据暂时不可读取。");
  }
  if (!["chenlong.auth-store/v4", "chenlong.auth-store/v5", "chenlong.auth-store/v6"].includes(value?.schemaVersion) || !Array.isArray(value.users)
    || !Array.isArray(value.teams) || !Array.isArray(value.sessions)) {
    throw new PlatformHttpError(503, "AUTH_STORE_INCOMPATIBLE", "统一账户数据版本不兼容。");
  }
  authStoreCache.set(authStorePath, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}

function enrichPrincipal(publicUser, authStore) {
  const stored = authStoreUserIndex(authStore).get(publicUser?.id);
  if (!stored || stored.username !== publicUser.username || stored.role !== publicUser.role) {
    throw new PlatformHttpError(401, "AUTHENTICATION_REQUIRED", "登录状态已失效，请重新登录。");
  }
  return Object.freeze({
    id: publicUser.id,
    username: publicUser.username,
    displayName: publicUser.displayName,
    role: publicUser.role,
    teamId: publicUser.role === "admin" ? null : stored.teamId,
    teamName: publicUser.role === "admin" ? null : publicUser.teamName,
    group: publicUser.role === "admin" ? null : publicUser.group,
    createdAt: publicUser.createdAt
  });
}

function copyRequestHeaders(request, { origin = null, principal = null, mapBundle = null } = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || EXTERNAL_PROXY_HEADERS.has(lower)
      || lower === "host" || lower === "content-length"
      || lower === contract.PRINCIPAL_HEADER || lower === contract.MAP_BUNDLE_HEADER
      || lower === "accept-encoding") continue;
    headers[name] = value;
  }
  headers["accept-encoding"] = "identity";
  if (origin) headers.origin = origin;
  if (principal) headers[contract.PRINCIPAL_HEADER] = principal;
  if (mapBundle) headers[contract.MAP_BUNDLE_HEADER] = mapBundle;
  return headers;
}

function readIncomingBody(request, maximum = MAX_PROXY_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentLength = request.headers["content-length"];
    if (Array.isArray(contentLength) || (contentLength !== undefined
      && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximum))) {
      request.resume();
      reject(new PlatformHttpError(413, "REQUEST_TOO_LARGE", "请求内容过大。"));
      return;
    }
    const chunks = [];
    let length = 0;
    let settled = false;
    request.on("data", chunk => {
      if (settled) return;
      length += chunk.length;
      if (length > maximum) {
        settled = true;
        reject(new PlatformHttpError(413, "REQUEST_TOO_LARGE", "请求内容过大。"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, length));
    });
    request.on("error", error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function rawUpstreamRequest(origin, requestPath, {
  method = "GET", headers = {}, body = null, timeoutMs = 15_000
} = {}) {
  const target = new URL(requestPath, origin);
  return new Promise((resolve, reject) => {
    const outgoingHeaders = { ...headers, host: target.host };
    if (body !== null) outgoingHeaders["content-length"] = body.length;
    const upstream = http.request(target, {
      method,
      headers: outgoingHeaders,
      agent: UPSTREAM_AGENT,
      timeout: timeoutMs
    }, response => {
      const chunks = [];
      let length = 0;
      response.on("data", chunk => {
        length += chunk.length;
        if (length > MAX_PROXY_BODY_BYTES) {
          upstream.destroy(new PlatformHttpError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "上游响应过大。"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode || 502,
        headers: response.headers,
        body: Buffer.concat(chunks, length)
      }));
    });
    upstream.on("timeout", () => upstream.destroy(new PlatformHttpError(504, "UPSTREAM_TIMEOUT", "子系统响应超时。")));
    upstream.on("error", reject);
    if (body !== null) upstream.end(body);
    else upstream.end();
  });
}

function parseUpstreamJson(result, label) {
  const type = String(result.headers["content-type"] || "").toLowerCase();
  if (!type.includes("application/json")) {
    throw new PlatformHttpError(502, "UPSTREAM_INVALID_RESPONSE", `${label}返回了无法识别的数据。`);
  }
  try {
    return JSON.parse(result.body.toString("utf8"));
  } catch (_error) {
    throw new PlatformHttpError(502, "UPSTREAM_INVALID_RESPONSE", `${label}返回了损坏的数据。`);
  }
}

async function probeReadiness(origin, requestPath, validate) {
  let result;
  try {
    result = await rawUpstreamRequest(origin, requestPath, {
      headers: { accept: "application/json" },
      timeoutMs: READINESS_TIMEOUT_MS
    });
  } catch (error) {
    return {
      check: {
        status: "error",
        code: error?.code === "UPSTREAM_TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE"
      },
      payload: null
    };
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { check: { status: "error", code: "UPSTREAM_HTTP_ERROR" }, payload: null };
  }
  let payload;
  try {
    payload = JSON.parse(result.body.toString("utf8"));
  } catch (_error) {
    return { check: { status: "error", code: "UPSTREAM_INVALID_RESPONSE" }, payload: null };
  }
  if (!validate(payload)) {
    return { check: { status: "error", code: "UPSTREAM_INVALID_RESPONSE" }, payload: null };
  }
  return { check: { status: "ok" }, payload };
}

async function platformReadiness(options) {
  const [python, blockly, workshop] = await Promise.all([
    probeReadiness(options.upstreams.python, "/api/health", payload => (
      payload?.schemaVersion === "chenlong.backend-health/v1" && payload.status === "ok"
    )),
    probeReadiness(options.upstreams.blockly, "/api/health", payload => (
      payload?.schemaVersion === "chenlong.blockly-health/v1" && payload.status === "ok"
    )),
    probeReadiness(options.upstreams.workshop, "/api/competition/health", payload => (
      payload?.ok === true && payload.service === "workshop-competition"
    ))
  ]);
  const checks = {
    gateway: { status: "ok" },
    python: python.check,
    blockly: blockly.check,
    workshop: workshop.check
  };
  const ready = Object.values(checks).every(check => check.status === "ok");
  const officialSsoConfigured = typeof python.payload?.capabilities?.officialSsoConfigured === "boolean"
    ? python.payload.capabilities.officialSsoConfigured
    : null;
  return {
    statusCode: ready ? 200 : 503,
    payload: {
      schemaVersion: PLATFORM_READINESS_SCHEMA_VERSION,
      status: ready ? "ok" : "degraded",
      service: "chenlong-competition-platform",
      checks,
      configuration: {
        trustedProxyConfigured: options.trustedProxyIps.size > 0,
        publicOriginConfigured: Boolean(options.publicOrigin),
        officialSsoConfigured
      },
      authoritative: false
    }
  };
}

function forwardedCookie(request) {
  return typeof request.headers.cookie === "string" ? request.headers.cookie : "";
}

async function pythonCurrentUser(request, options) {
  const result = await rawUpstreamRequest(options.upstreams.python, "/api/v1/auth/me", {
    headers: { accept: "application/json", cookie: forwardedCookie(request) }
  });
  if (result.statusCode === 401 || result.statusCode === 403) {
    throw new PlatformHttpError(401, "AUTHENTICATION_REQUIRED", "请先登录统一比赛平台。", {
      "WWW-Authenticate": "Cookie realm=\"chenlong-platform\""
    });
  }
  if (result.statusCode !== 200) {
    throw new PlatformHttpError(503, "AUTH_SERVICE_UNAVAILABLE", "统一账户服务暂时不可用。");
  }
  const payload = parseUpstreamJson(result, "统一账户服务");
  if (payload?.schemaVersion !== "chenlong.auth/v1" || payload.authenticated !== true || !payload.user) {
    throw new PlatformHttpError(502, "AUTH_RESPONSE_INVALID", "统一账户服务响应不兼容。");
  }
  return enrichPrincipal(payload.user, readAuthStore(options.authStorePath));
}

function requireAdmin(user) {
  if (user.role !== "admin") throw new PlatformHttpError(403, "ADMIN_REQUIRED", "需要管理员权限。");
  return user;
}

function pythonTaskToBlockly(taskId) {
  return contract.PLATFORM_TO_BLOCKLY_TASK[contract.platformTaskId(taskId)] || null;
}

function mapLayoutForBlockly(layout) {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)
    || layout.schemaVersion !== "chenlong.guangyang-map-layout/v2"
    || !Array.isArray(layout.checkpoints) || !Array.isArray(layout.targets)
    || !Array.isArray(layout.storage) || !Array.isArray(layout.distractors)
    || !Array.isArray(layout.obstacles)) {
    throw new PlatformHttpError(502, "MAP_RESPONSE_INVALID", "Python 地图布局无效。");
  }
  return {
    schemaVersion: layout.schemaVersion,
    checkpoints: layout.checkpoints,
    targets: layout.targets,
    storage: layout.storage,
    distractors: layout.distractors,
    obstacles: layout.obstacles
  };
}

function assignedVariantId(taskId, teamId) {
  const counts = {
    "R2-GYI-MVP-01": 8,
    "R2-GYI-MVP-02": 10,
    "R2-GYI-MVP-03": 12
  };
  const count = counts[taskId];
  if (!count || !/^tea_[a-f0-9]{32}$/.test(teamId || "")) {
    throw new PlatformHttpError(502, "MAP_ASSIGNMENT_INVALID", "队伍地图分配信息无效。");
  }
  const digest = crypto.createHash("sha256")
    .update(`chenlong-map-pool/v1\0${taskId}\0${teamId}`, "utf8")
    .digest();
  return `map-${String(digest.readUInt32BE(0) % count + 1).padStart(2, "0")}`;
}

async function blocklyMapsForRequest(request, options, user) {
  if (!user || (user.role !== "admin" && !user.teamId)) {
    throw new PlatformHttpError(403, "PARTICIPANT_REQUIRED", "当前账户没有可用的比赛地图。");
  }
  const maps = await Promise.all(Object.entries(contract.PLATFORM_TO_PYTHON_TASK).map(async ([platformTask, pythonTask]) => {
    const pythonMapPath = user.role === "admin"
      ? `/api/v1/admin/map-config/${pythonTask}/map-01`
      : `/api/v1/map-config/${pythonTask}`;
    const result = await rawUpstreamRequest(options.upstreams.python, pythonMapPath, {
      headers: { accept: "application/json", cookie: forwardedCookie(request) }
    });
    if (result.statusCode !== 200) {
      if ([401, 403].includes(result.statusCode)) {
        throw new PlatformHttpError(401, "AUTHENTICATION_REQUIRED", "请先登录统一比赛平台。");
      }
      throw new PlatformHttpError(503, "MAP_SERVICE_UNAVAILABLE", "Python 地图服务暂时不可用。");
    }
    const map = parseUpstreamJson(result, "Python 地图服务");
    const blocklyTask = contract.PLATFORM_TO_BLOCKLY_TASK[platformTask];
    if (!blocklyTask || map?.schemaVersion !== "chenlong.guangyang-map-config/v1"
      || !/^[a-f0-9]{64}$/.test(map.digest || "") || !Number.isSafeInteger(map.revision)
      || map.revision < 0 || (map.updatedAt !== null && !Number.isFinite(Date.parse(map.updatedAt)))) {
      throw new PlatformHttpError(502, "MAP_RESPONSE_INVALID", "Python 地图服务响应不兼容。");
    }
    const layout = mapLayoutForBlockly(map.layout);
    const layoutDigest = crypto.createHash("sha256")
      .update(contract.canonicalJson(layout), "utf8")
      .digest("hex");
    if (layoutDigest !== map.digest) {
      throw new PlatformHttpError(502, "MAP_RESPONSE_INVALID", "Python 地图摘要与布局不一致。");
    }
    return {
      taskId: blocklyTask,
      sourceTaskId: pythonTask,
      variantId: user.role === "admin" ? "map-01" : assignedVariantId(pythonTask, user.teamId),
      revision: map.revision,
      digest: map.digest,
      updatedAt: map.updatedAt,
      layout
    };
  }));
  return maps;
}

function signedPrincipal(options, audience, user) {
  return contract.signPrincipal(options.secret, audience, user);
}

function signedMapBundle(options, maps) {
  return contract.signMapBundle(options.secret, maps);
}

function responseHeadersForClient(headers, scope = null) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "content-length" || lower === "content-encoding") continue;
    if (scope !== "python" && lower === "set-cookie") continue;
    output[name] = value;
  }
  return output;
}

function rewriteLocation(value, scope) {
  if (typeof value !== "string" || !value.startsWith("/")) return value;
  if (scope === "python" && value.startsWith("/login.html")) {
    let login;
    try {
      login = new URL(value, "http://python.internal");
    } catch (_error) {
      return value;
    }
    const returnTo = login.searchParams.get("returnTo");
    if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
      const mountedReturnTo = returnTo === "/"
        ? "/python/"
        : returnTo.startsWith("/python/")
          ? returnTo
          : `/python${returnTo}`;
      login.searchParams.set("returnTo", mountedReturnTo);
    }
    return `${login.pathname}${login.search}${login.hash}`;
  }
  if (scope === "workshop") {
    if (value.startsWith("/_next/") || value.startsWith("/models/")
      || value.startsWith("/api/competition") || value.startsWith("/api/v1/")
      || value.startsWith("/portal.html") || value.startsWith("/admin.html")
      || value.startsWith("/login.html") || isWorkshopAssetPath(value)) return value;
    if (value.startsWith("/workshop/")) return value;
  }
  return `/${scope}${value}`.replace(/\/{2,}/g, "/");
}

function centralLoginLocation(returnTo) {
  const parameters = new URLSearchParams({ returnTo });
  return `/login.html?${parameters.toString()}`;
}

function redirectPageToCentralLogin(response, returnTo) {
  response.writeHead(302, {
    Location: centralLoginLocation(returnTo),
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff"
  });
  response.end();
}

function rewriteTextBody(body, scope, contentType) {
  let text = body.toString("utf8");
  if (scope === "python") {
    text = text.replace(/(["'`])\/api\/(v1|health)/g, `$1/python/api/$2`)
      .replace(/(["'`])\/(records|admin|index)\.html/g, `$1/python/$2.html`);
  } else if (scope === "blockly") {
    text = text.replace(/(["'`])\/api\//g, `$1/blockly/api/`)
      .replace(/(["'`])\/(admin|index)\.html/g, `$1/blockly/$2.html`);
  } else if (scope === "workshop") {
    text = text.replace(/(["'`])\/competition(?=[/"'`?#]|\$\{)/g, `$1/workshop/competition`);
  }
  if (contentType.includes("text/html") && scope !== "workshop") {
    const rootAttribute = new RegExp(`(<(?:script|link|img|a|form)[^>]+(?:src|href|action)=(["']))/(?!/|${scope}/)`, "gi");
    text = text.replace(rootAttribute,
      (match, prefix) => `${prefix}/${scope}/`);
    if (scope === "python" || scope === "blockly") {
      text = text.replace(new RegExp(`/${scope}/(login|portal)\\.html`, "g"), "/$1.html");
    }
  }
  return Buffer.from(text, "utf8");
}

function isRewritableType(contentType) {
  const type = String(contentType || "").toLowerCase();
  return type.includes("text/html") || type.includes("javascript") || type.includes("text/css");
}

async function proxyBuffered(request, response, options, {
  scope, upstreamPath, principal = null, maps = null, cacheControl = "no-store, max-age=0",
  timeoutMs = 15_000, maximumRequestBytes = MAX_PROXY_BODY_BYTES, headAsGet = false
}) {
  assertExternalOrigin(request, options.publicOrigin);
  const origin = options.upstreams[scope];
  // Vinext/Vite sends browser module requests with an Origin header even for
  // GET.  Forwarding the public tunnel origin makes the local development
  // server reject its own entry module, so React never hydrates and the
  // workshop remains stuck on its loading state.  The gateway is the trusted
  // boundary: always present workshop requests as same-origin to its local
  // upstream, while retaining write-only Origin rewriting for the other apps.
  const requestOrigin = scope === "workshop"
    ? origin
    : WRITE_METHODS.has(request.method || "GET")
      // Python validates browser writes against the configured public
      // platform Origin.  Replacing it with the loopback upstream works only
      // in local mode and breaks administrator changes through an HTTPS
      // tunnel.  Blockly has no independent public Origin and continues to
      // receive its own loopback Origin behind this trusted gateway.
      ? (["python", "blockly"].includes(scope) ? (options.publicOrigin || origin) : origin)
      : null;
  const body = ["GET", "HEAD"].includes(request.method || "GET")
    ? null
    : await readIncomingBody(request, maximumRequestBytes);
  const headers = copyRequestHeaders(request, {
    origin: requestOrigin,
    principal: principal ? signedPrincipal(options, scope === "workshop" ? "workshop" : "blockly", principal) : null,
    mapBundle: maps ? signedMapBundle(options, maps) : null
  });
  const upstreamMethod = headAsGet && request.method === "HEAD" ? "GET" : request.method;
  const result = await rawUpstreamRequest(origin, upstreamPath, {
    method: upstreamMethod,
    headers,
    body,
    timeoutMs
  });
  const contentType = String(result.headers["content-type"] || "");
  const outgoingHeaders = responseHeadersForClient(result.headers, scope);
  if (outgoingHeaders.location) outgoingHeaders.location = rewriteLocation(outgoingHeaders.location, scope);
  const outgoingBody = isRewritableType(contentType)
    ? rewriteTextBody(result.body, scope, contentType.toLowerCase())
    : result.body;
  outgoingHeaders["content-length"] = outgoingBody.length;
  outgoingHeaders["cache-control"] = cacheControl;
  if (result.statusCode === 200 && cacheControl.startsWith("public,")) {
    const etag = assetEtag(outgoingBody);
    outgoingHeaders.etag = etag;
    if (request.headers["if-none-match"] === etag && ["GET", "HEAD"].includes(request.method || "GET")) {
      delete outgoingHeaders["content-length"];
      response.writeHead(304, outgoingHeaders);
      response.end();
      return;
    }
  }
  response.writeHead(result.statusCode, outgoingHeaders);
  if (request.method === "HEAD") response.end();
  else response.end(outgoingBody);
}

function proxyStreamed(request, response, options, {
  scope, upstreamPath, cacheControl = "public, max-age=3600", timeoutMs = 30_000
}) {
  assertExternalOrigin(request, options.publicOrigin);
  if (!["GET", "HEAD"].includes(request.method || "GET")) {
    throw new PlatformHttpError(405, "METHOD_NOT_ALLOWED", "静态资源只允许读取。");
  }
  const origin = options.upstreams[scope];
  const target = new URL(upstreamPath, origin);
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (error && !responseStarted) reject(error);
      else {
        if (error) response.destroy(error);
        resolve();
      }
    };
    const upstream = http.request(target, {
      method: request.method,
      headers: copyRequestHeaders(request, { origin: scope === "workshop" ? origin : null }),
      agent: UPSTREAM_AGENT,
      timeout: timeoutMs
    }, upstreamResponse => {
      const headers = responseHeadersForClient(upstreamResponse.headers, scope);
      if (headers.location) headers.location = rewriteLocation(headers.location, scope);
      const length = Number(upstreamResponse.headers["content-length"]);
      if (Number.isSafeInteger(length) && length >= 0) headers["content-length"] = String(length);
      headers["cache-control"] = cacheControl;
      responseStarted = true;
      response.writeHead(upstreamResponse.statusCode || 502, headers);
      if (request.method === "HEAD") {
        upstreamResponse.resume();
        response.end();
        finish();
        return;
      }
      upstreamResponse.on("error", finish);
      upstreamResponse.on("end", () => finish());
      upstreamResponse.pipe(response);
    });
    upstream.on("timeout", () => upstream.destroy(new PlatformHttpError(504, "UPSTREAM_TIMEOUT", "子系统响应超时。")));
    upstream.on("error", finish);
    response.on("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    upstream.end();
  });
}

async function proxyPythonAuth(request, response, options, upstreamPath, additionalHeaders = {}) {
  assertExternalOrigin(request, options.publicOrigin);
  const body = ["GET", "HEAD"].includes(request.method || "GET")
    ? null
    : await readIncomingBody(request, MAX_AUTH_PROXY_BODY_BYTES);
  const headers = copyRequestHeaders(request, {
    origin: WRITE_METHODS.has(request.method || "GET")
      ? (options.publicOrigin || options.upstreams.python)
      : null
  });
  Object.assign(headers, additionalHeaders);
  const result = await rawUpstreamRequest(options.upstreams.python, upstreamPath, {
    method: request.method,
    headers,
    body
  });
  const outgoingHeaders = responseHeadersForClient(result.headers, "python");
  outgoingHeaders["content-length"] = result.body.length;
  response.writeHead(result.statusCode, outgoingHeaders);
  response.end(request.method === "HEAD" ? undefined : result.body);
}

function normalizedScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100 ? Math.round(score * 100) / 100 : null;
}

function highestScores(records, taskMap, { ownerUserId = null, teamId = null } = {}) {
  const scores = Object.fromEntries(TASKS.map(task => [task, null]));
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.recordState !== "submitted") continue;
    if (ownerUserId && record.ownerUserId !== ownerUserId && record.user?.id !== ownerUserId) continue;
    if (teamId && record.teamId !== teamId && record.user?.teamId !== teamId) continue;
    const task = taskMap(record.taskId);
    const score = normalizedScore(record.score);
    if (!task || score === null) continue;
    if (scores[task] === null || score > scores[task]) scores[task] = score;
  }
  return scores;
}

function mergeTaskScores(left, right) {
  return Object.fromEntries(TASKS.map(task => {
    const values = [left?.[task], right?.[task]].filter(Number.isFinite);
    return [task, values.length ? Math.max(...values) : null];
  }));
}

function workshopScoreFromStanding(standing) {
  if (standing?.status !== "scored") return null;
  const micros = Number(standing.scoreMicros);
  return Number.isFinite(micros) && micros >= 0 && micros <= 1_000_000
    ? Math.round(micros / 100) / 100
    : null;
}

function combinedScore(taskScores, workshopScore) {
  // The official CSV contract exposes two integer score fields and requires
  // total_score to equal their sum.  Reuse that canonical calculation here so
  // the admin board and official package cannot disagree at .5 boundaries.
  return officialScores.scoreContributions(taskScores, workshopScore).total_score;
}

function teamKey(teamId, teamName, division) {
  return teamId || `name:${String(teamName || "").normalize("NFKC").trim().toLowerCase()}\0${division || ""}`;
}

function buildAdminRows({ users, pythonRecords, blocklyRecords, workshopOverview, assignments }) {
  const teams = new Map();
  const usersById = new Map(users.map(user => [user.id, user]));
  for (const user of users) {
    if (user.role === "admin" || !user.teamName) continue;
    const assignment = assignments.find(item => item.members?.some(member => member.userId === user.id)) || null;
    const id = assignment?.teamId || null;
    const division = contract.divisionForGroup(user.group);
    const key = teamKey(id, user.teamName, division);
    const current = teams.get(key) || {
      teamId: id,
      teamName: user.teamName,
      group: user.group,
      division,
      members: [],
      maps: assignment?.maps || [],
      pythonScores: Object.fromEntries(TASKS.map(task => [task, null])),
      blocklyScores: Object.fromEntries(TASKS.map(task => [task, null])),
      workshopScore: null
    };
    current.members.push({ id: user.id, username: user.username, displayName: user.displayName });
    teams.set(key, current);
  }
  for (const record of pythonRecords) {
    if (record?.recordState !== "submitted") continue;
    const owner = record.user || usersById.get(record.ownerUserId) || null;
    const assignment = assignments.find(item => item.members?.some(member => member.userId === owner?.id)) || null;
    const immutableTeamId = typeof record.teamId === "string" && teams.has(record.teamId)
      ? record.teamId
      : null;
    const key = teamKey(immutableTeamId || assignment?.teamId || null, owner?.teamName, contract.divisionForGroup(owner?.group));
    const team = teams.get(key);
    const task = contract.platformTaskId(record.taskId);
    const score = normalizedScore(record.score);
    if (team && task && score !== null && (team.pythonScores[task] === null || score > team.pythonScores[task])) {
      team.pythonScores[task] = score;
    }
  }
  for (const record of blocklyRecords) {
    if (record?.recordState !== "submitted") continue;
    const owner = record.user || usersById.get(record.ownerUserId) || null;
    const recordTeamId = record.teamId || owner?.teamId || null;
    const key = teamKey(recordTeamId, owner?.teamName, contract.divisionForGroup(owner?.group));
    let team = teams.get(key);
    if (!team && owner?.teamName) {
      team = [...teams.values()].find(item => item.teamName === owner.teamName) || null;
    }
    const task = contract.platformTaskId(record.taskId);
    const score = normalizedScore(record.score);
    if (team && task && score !== null && (team.blocklyScores[task] === null || score > team.blocklyScores[task])) {
      team.blocklyScores[task] = score;
    }
  }
  const standings = Object.values(workshopOverview?.leaderboards || {}).flat();
  for (const standing of standings) {
    const key = teamKey(standing.teamId, standing.teamName, standing.division);
    let team = teams.get(key);
    if (!team) team = [...teams.values()].find(item => item.teamName === standing.teamName && item.division === standing.division) || null;
    if (team) team.workshopScore = workshopScoreFromStanding(standing);
  }
  return [...teams.values()].map(team => {
    const taskScores = mergeTaskScores(team.pythonScores, team.blocklyScores);
    return {
      ...team,
      taskScores,
      totalScore: combinedScore(taskScores, team.workshopScore)
    };
  }).sort((left, right) => right.totalScore - left.totalScore
    || left.teamName.localeCompare(right.teamName, "zh-CN"));
}

function paginate(items, requestedPage, pageSize = ADMIN_PAGE_SIZE) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Number.isSafeInteger(requestedPage) ? requestedPage : 1, 1), totalPages);
  const start = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total,
    totalPages,
    items: items.slice(start, start + pageSize)
  };
}

async function jsonFromService(origin, requestPath, request, headers = {}, label = "子系统") {
  const result = await rawUpstreamRequest(origin, requestPath, {
    headers: { accept: "application/json", cookie: forwardedCookie(request), ...headers }
  });
  if (result.statusCode !== 200) {
    if ([401, 403].includes(result.statusCode)) throw new PlatformHttpError(result.statusCode, "UPSTREAM_ACCESS_DENIED", `${label}拒绝了当前账户。`);
    throw new PlatformHttpError(503, "UPSTREAM_UNAVAILABLE", `${label}暂时不可用。`);
  }
  return parseUpstreamJson(result, label);
}

async function allRecordPagesFromService(origin, requestPath, request, headers = {}, label = "成绩子系统") {
  const pageSize = 1000;
  const separator = requestPath.includes("?") ? "&" : "?";
  const first = await jsonFromService(
    origin,
    `${requestPath}${separator}page=1&pageSize=${pageSize}`,
    request,
    headers,
    label
  );
  if (!Array.isArray(first.records)) {
    throw new PlatformHttpError(502, "UPSTREAM_INVALID_RESPONSE", `${label}返回了不完整的成绩列表。`);
  }
  const totalPages = Number(first.pagination?.totalPages);
  if (!Number.isSafeInteger(totalPages) || totalPages <= 1) return first.records;
  if (totalPages > 20) {
    throw new PlatformHttpError(503, "UPSTREAM_RESULT_TOO_LARGE", `${label}成绩数量超过后台汇总上限。`);
  }
  const remaining = await Promise.all(Array.from({ length: totalPages - 1 }, (_, index) =>
    jsonFromService(
      origin,
      `${requestPath}${separator}page=${index + 2}&pageSize=${pageSize}`,
      request,
      headers,
      label
    )));
  const pages = [first, ...remaining];
  if (pages.some((page, index) => !Array.isArray(page.records)
    || Number(page.pagination?.page) !== index + 1
    || Number(page.pagination?.totalPages) !== totalPages)) {
    throw new PlatformHttpError(502, "UPSTREAM_INVALID_RESPONSE", `${label}分页成绩响应不一致。`);
  }
  return pages.flatMap(page => page.records);
}

async function blocklyTeamTaskScores(request, options, principalHeader, label = "Blockly 成绩后台") {
  const payload = await jsonFromService(options.upstreams.blockly, "/api/admin/team-task-scores", request, {
    [contract.PRINCIPAL_HEADER]: principalHeader
  }, label);
  if (payload.schemaVersion !== "chenlong.blockly-team-task-scores/v1" || !Array.isArray(payload.records)) {
    throw new PlatformHttpError(502, "UPSTREAM_INVALID_RESPONSE", `${label}返回了不完整的最佳分聚合。`);
  }
  return payload.records;
}

async function pythonTeamTaskScores(request, options, label = "Python 成绩后台") {
  const payload = await jsonFromService(options.upstreams.python, "/api/v1/admin/team-task-scores", request, {}, label);
  if (payload.schemaVersion !== "chenlong.python-team-task-scores/v1" || !Array.isArray(payload.records)) {
    throw new PlatformHttpError(502, "UPSTREAM_INVALID_RESPONSE", `${label}返回了不完整的最佳分聚合。`);
  }
  return payload.records;
}

async function handlePlatformMe(request, response, options) {
  const user = await pythonCurrentUser(request, options);
  // Do not expose the official identity itself to the browser.  The portal only
  // needs to know whether this session belongs to a user that entered through
  // the official SSO entrypoint, so it can remove the logout route back to the
  // local account forms.
  const storedUser = user.role === "user"
    ? authStoreUserIndex(readAuthStore(options.authStorePath)).get(user.id)
    : null;
  jsonBody(response, 200, {
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    authenticated: true,
    user: {
      ...user,
      officialSso: Boolean(storedUser?.officialUserId)
    },
    services: {
      python: "/python/",
      blockly: "/blockly/",
      workshop: "/workshop/",
      admin: user.role === "admin" ? "/admin.html" : null
    },
    authoritative: false
  });
}

async function handlePersonalScores(request, response, options) {
  const user = await pythonCurrentUser(request, options);
  const principalHeader = signedPrincipal(options, "blockly", user);
  const [pythonResult, blocklyResult, workshopResult] = await Promise.allSettled([
    allRecordPagesFromService(options.upstreams.python, "/api/v1/records", request, {}, "Python 赛题"),
    allRecordPagesFromService(options.upstreams.blockly, "/api/records", request, {
      [contract.PRINCIPAL_HEADER]: principalHeader,
      [contract.MAP_BUNDLE_HEADER]: signedMapBundle(options, await blocklyMapsForRequest(request, options, user))
    }, "Blockly 赛题"),
    jsonFromService(options.upstreams.workshop, "/api/competition/me", request, {
      [contract.PRINCIPAL_HEADER]: signedPrincipal(options, "workshop", user)
    }, "识物工坊")
  ]);
  const pythonScores = pythonResult.status === "fulfilled"
    ? highestScores(pythonResult.value, contract.platformTaskId, { ownerUserId: user.id })
    : Object.fromEntries(TASKS.map(task => [task, null]));
  const blocklyScores = blocklyResult.status === "fulfilled"
    ? highestScores(blocklyResult.value, contract.platformTaskId)
    : Object.fromEntries(TASKS.map(task => [task, null]));
  jsonBody(response, 200, {
    schemaVersion: PERSONAL_SCORES_SCHEMA_VERSION,
    user,
    taskScores: mergeTaskScores(pythonScores, blocklyScores),
    sources: { python: pythonScores, blockly: blocklyScores },
    workshop: workshopResult.status === "fulfilled"
      ? { available: true, latestSubmission: workshopResult.value.latestSubmission || null }
      : { available: false, latestSubmission: null },
    authoritative: false
  });
}

async function handleAdminOverview(request, response, options, url) {
  const admin = requireAdmin(await pythonCurrentUser(request, options));
  const blocklyPrincipal = signedPrincipal(options, "blockly", admin);
  const workshopPrincipal = signedPrincipal(options, "workshop", admin);
  const [usersPayload, pythonPayload, mapPayload, blocklyPayload, workshopPayload] = await Promise.all([
    jsonFromService(options.upstreams.python, "/api/v1/admin/users", request, {}, "Python 用户后台"),
    pythonTeamTaskScores(request, options),
    jsonFromService(options.upstreams.python, "/api/v1/admin/map-pools", request, {}, "Python 地图后台"),
    blocklyTeamTaskScores(request, options, blocklyPrincipal),
    jsonFromService(options.upstreams.workshop, "/api/competition/admin/overview", request, {
      [contract.PRINCIPAL_HEADER]: workshopPrincipal
    }, "识物工坊后台")
  ]);
  const rows = buildAdminRows({
    users: usersPayload.users || [],
    pythonRecords: pythonPayload,
    blocklyRecords: blocklyPayload,
    workshopOverview: workshopPayload,
    assignments: mapPayload.assignments || []
  });
  const requestedGroups = url.searchParams.getAll("group");
  const requestedGroup = requestedGroups.length === 0 || requestedGroups[0] === ""
    ? null
    : contract.canonicalParticipantGroup(requestedGroups[0]);
  if (requestedGroups.length > 1 || (requestedGroups.length === 1 && requestedGroups[0] !== "" && !requestedGroup)) {
    throw new PlatformHttpError(400, "ADMIN_OVERVIEW_INVALID_GROUP", "分组筛选值无效。");
  }
  const filteredRows = requestedGroup
    ? rows.filter(team => contract.canonicalParticipantGroup(team.group) === requestedGroup)
    : rows;
  const pageValue = Number(url.searchParams.get("page") || 1);
  const page = paginate(filteredRows, Number.isSafeInteger(pageValue) ? pageValue : 1);
  jsonBody(response, 200, {
    schemaVersion: ADMIN_OVERVIEW_SCHEMA_VERSION,
    scoring: {
      task1Weight: 25,
      task2Weight: 25,
      task3Weight: 25,
      workshopWeight: 25,
      maximum: 100
    },
    pagination: {
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      totalPages: page.totalPages,
      unfilteredTotal: rows.length
    },
    teams: page.items,
    evaluationSets: workshopPayload.evaluationSets || [],
    links: {
      pythonMaps: "/python/admin.html#maps",
      blocklyRecords: "/blockly/admin.html?platform=1",
      workshopSettings: "/workshop/competition/admin"
    },
    authoritative: false
  });
}

async function handleAdminUsers(request, response, options) {
  requireAdmin(await pythonCurrentUser(request, options));
  const payload = await jsonFromService(
    options.upstreams.python,
    "/api/v1/admin/users",
    request,
    {},
    "Python 用户后台"
  );
  const authStore = readAuthStore(options.authStorePath);
  const storedById = authStoreUserIndex(authStore);
  jsonBody(response, 200, {
    schemaVersion: "chenlong.platform-admin-users/v1",
    users: (payload.users || []).map(user => ({
      ...user,
      teamId: user.role === "admin" ? null : storedById.get(user.id)?.teamId || null,
      officialUserId: user.role === "admin" ? null : storedById.get(user.id)?.officialUserId || null,
      officialTeamId: user.role === "admin" ? null : storedById.get(user.id)?.officialTeamId || null
    })),
    authoritative: false
  });
}

async function handleAdminUserUpdate(request, response, options, userId) {
  requireAdmin(await pythonCurrentUser(request, options));
  await proxyBuffered(request, response, options, {
    scope: "python",
    upstreamPath: `/api/v1/admin/users/${userId}`
  });
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function adminRowsCsv(rows) {
  const header = ["队伍名称", "分组", "任务1", "任务2", "任务3", "识物工坊", "总分", "任务1地图", "任务2地图", "任务3地图"];
  const data = rows.map(team => [
    team.teamName,
    PARTICIPANT_GROUP_LABELS[contract.canonicalParticipantGroup(team.group)] || "",
    team.taskScores.task1 ?? "",
    team.taskScores.task2 ?? "",
    team.taskScores.task3 ?? "",
    team.workshopScore ?? "",
    team.totalScore,
    ...TASKS.map(task => team.maps.find(map => contract.platformTaskId(map.taskId) === task)?.variantNumber || "")
  ]);
  return `\uFEFF${[header, ...data].map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

async function handleAdminExport(request, response, options) {
  const admin = requireAdmin(await pythonCurrentUser(request, options));
  const [usersPayload, pythonPayload, mapPayload, blocklyPayload, workshopPayload] = await Promise.all([
    jsonFromService(options.upstreams.python, "/api/v1/admin/users", request),
    pythonTeamTaskScores(request, options),
    jsonFromService(options.upstreams.python, "/api/v1/admin/map-pools", request),
    blocklyTeamTaskScores(request, options, signedPrincipal(options, "blockly", admin)),
    jsonFromService(options.upstreams.workshop, "/api/competition/admin/overview", request, {
      [contract.PRINCIPAL_HEADER]: signedPrincipal(options, "workshop", admin)
    })
  ]);
  const rows = buildAdminRows({
    users: usersPayload.users || [], pythonRecords: pythonPayload,
    blocklyRecords: blocklyPayload, workshopOverview: workshopPayload,
    assignments: mapPayload.assignments || []
  });
  const body = Buffer.from(adminRowsCsv(rows), "utf8");
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="competition-overview-${new Date().toISOString().slice(0, 10)}.csv"`,
    "Cache-Control": "no-store, max-age=0"
  });
  response.end(body);
}

function createServer(config = {}) {
  const options = {
    upstreams: {
      python: normalizedUpstream(config.pythonOrigin || process.env.CHENLONG_PYTHON_ORIGIN, DEFAULT_UPSTREAMS.python),
      blockly: normalizedUpstream(config.blocklyOrigin || process.env.CHENLONG_BLOCKLY_ORIGIN, DEFAULT_UPSTREAMS.blockly),
      workshop: normalizedUpstream(config.workshopOrigin || process.env.CHENLONG_WORKSHOP_ORIGIN, DEFAULT_UPSTREAMS.workshop)
    },
    publicOrigin: normalizedPublicOrigin(config.publicOrigin || process.env.CHENLONG_PLATFORM_PUBLIC_ORIGIN),
    authStorePath: path.resolve(config.authStorePath || process.env.CHENLONG_PYTHON_AUTH_STORE || DEFAULT_AUTH_STORE),
    publicDir: path.resolve(config.publicDir || path.join(__dirname, "public")),
    secret: platformSecret(config.secret),
    trustedProxyIps: normalizedTrustedProxyIps(
      config.trustedProxyIps ?? process.env.CHENLONG_PLATFORM_TRUSTED_PROXIES
    )
  };
  if (config.scoreDownloadService) {
    options.scoreDownloadService = config.scoreDownloadService;
  } else {
    const scoreDownloadConfig = config.scoreDownload || {};
    const scoreDownloadEnvironment = scoreDownloadConfig.env || process.env;
    const snapshotConfigured = Boolean(
      scoreDownloadConfig.snapshotPath || scoreDownloadEnvironment.CHENLONG_SCORE_DOWNLOAD_SNAPSHOT_PATH
    );
    const explicitScoreDataSource = scoreDownloadConfig.scoreDataSource || config.scoreDataSource;
    const scoreDataSource = explicitScoreDataSource || (!snapshotConfigured
      ? liveScores.createLiveScoreDataSource({
        upstreams: options.upstreams,
        secret: options.secret,
        authStorePath: options.authStorePath,
        promotionFile: scoreDownloadConfig.promotionFile
      })
      : null);
    options.scoreDownloadService = officialScores.createScoreDownloadService({
      ...scoreDownloadConfig,
      publicOrigin: scoreDownloadConfig.publicOrigin || options.publicOrigin || undefined,
      ...(scoreDataSource ? { scoreDataSource } : {}),
      identityDataSource: scoreDownloadConfig.identityDataSource || config.scoreIdentityDataSource
    });
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, requestExternalOrigin(request, options.publicOrigin));
      const pathname = safePathname(url.pathname);
      if (pathname === officialScores.BATCH_PATH || pathname.startsWith(officialScores.DOWNLOAD_PATH_PREFIX)) {
        await options.scoreDownloadService.handle(request, response, {
          pathname,
          externalOrigin: requestExternalOrigin(request, options.publicOrigin)
        });
        return;
      }
      if (pathname === "/sso/jump") {
        await proxyPythonAuth(
          request,
          response,
          options,
          `/api/v1/auth/sso/jump${url.search}`,
          { "x-forwarded-for": clientIpForRequest(request, options.trustedProxyIps) }
        );
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        if (servePublic(request, response, options.publicDir, pathname)) return;
      }

      if (pathname === "/api/health" && ["GET", "HEAD"].includes(request.method)) {
        jsonBody(response, 200, {
          schemaVersion: PLATFORM_SCHEMA_VERSION,
          status: "ok",
          service: "chenlong-competition-platform",
        federationKeyId: crypto.createHash("sha256").update(options.secret, "utf8").digest("hex").slice(0, 16),
        trustedProxyCount: options.trustedProxyIps.size,
          port: DEFAULT_PORT,
          capacity: {
            maxAccounts: 2_000,
            plannedConcurrentUsers: 500,
            upstreamMaxSocketsPerService: UPSTREAM_AGENT.maxSockets,
            listenBacklog: 2_048,
            adminTeamPageSize: ADMIN_PAGE_SIZE
          },
          authoritative: false
        });
        return;
      }
      if (pathname === "/api/readiness" && ["GET", "HEAD"].includes(request.method)) {
        const readiness = await platformReadiness(options);
        jsonBody(response, readiness.statusCode, readiness.payload);
        return;
      }
      if (pathname === "/api/platform/me" && request.method === "GET") {
        await handlePlatformMe(request, response, options);
        return;
      }
      if (pathname === "/api/platform/scores/me" && request.method === "GET") {
        await handlePersonalScores(request, response, options);
        return;
      }
      if (pathname === "/api/platform/admin/overview" && request.method === "GET") {
        await handleAdminOverview(request, response, options, url);
        return;
      }
      if (pathname === "/api/platform/admin/export" && request.method === "GET") {
        await handleAdminExport(request, response, options);
        return;
      }
      if (pathname === "/api/platform/admin/users" && request.method === "GET") {
        await handleAdminUsers(request, response, options);
        return;
      }
      const platformAdminUserMatch = pathname.match(/^\/api\/platform\/admin\/users\/(usr_[a-f0-9]{32})$/);
      if (platformAdminUserMatch && request.method === "PATCH") {
        await handleAdminUserUpdate(request, response, options, platformAdminUserMatch[1]);
        return;
      }
      if (pathname === "/api/platform/team-invite" && request.method === "GET") {
        await pythonCurrentUser(request, options);
        await proxyPythonAuth(request, response, options, "/api/v1/auth/team-invite");
        return;
      }

      if (pathname.startsWith("/api/v1/auth/")) {
        await proxyPythonAuth(request, response, options, pathname);
        return;
      }
      if (pathname.startsWith("/python/")) {
        const upstreamPath = `${pathname.slice("/python".length)}${url.search}`;
        if (STATIC_STREAM_PATH_PATTERN.test(pathname)) {
          await proxyStreamed(request, response, options, {
            scope: "python",
            upstreamPath,
            cacheControl: "public, max-age=86400"
          });
          return;
        }
        const cacheControl = textAssetCacheControl(pathname, url.searchParams);
        await proxyBuffered(request, response, options, {
          scope: "python",
          upstreamPath,
          cacheControl,
          headAsGet: cacheControl.startsWith("public,"),
          timeoutMs: pathname.includes("/api/") ? 120_000 : 15_000
        });
        return;
      }
      if (pathname === "/blockly/login.html" && ["GET", "HEAD"].includes(request.method)) {
        response.writeHead(302, {
          Location: "/login.html?returnTo=%2Fblockly%2F",
          "Cache-Control": "no-store, max-age=0"
        });
        response.end();
        return;
      }
      if (pathname === "/blockly/api/maps" && request.method === "GET") {
        const user = await pythonCurrentUser(request, options);
        jsonBody(response, 200, {
          schemaVersion: MAPS_SCHEMA_VERSION,
          maps: await blocklyMapsForRequest(request, options, user),
          authoritative: false
        });
        return;
      }
      if (pathname === "/blockly/api/auth/me" && request.method === "GET") {
        const user = await pythonCurrentUser(request, options);
        jsonBody(response, 200, {
          schemaVersion: "chenlong.blockly-auth/v1",
          authenticated: true,
          user: { ...user, teamId: undefined },
          authoritative: false
        });
        return;
      }
      if (pathname === "/blockly/api/auth/team-invite" && request.method === "GET") {
        const user = await pythonCurrentUser(request, options);
        if (user.role === "admin") throw new PlatformHttpError(403, "ADMIN_HAS_NO_TEAM", "管理员账户没有队伍邀请码。");
        const result = await jsonFromService(options.upstreams.python, "/api/v1/auth/team-invite", request);
        jsonBody(response, 200, {
          schemaVersion: "chenlong.blockly-team-invite/v1",
          teamName: result.teamName,
          inviteCode: result.inviteCode,
          authoritative: false
        });
        return;
      }
      if (pathname === "/blockly/api/auth/logout" && request.method === "POST") {
        assertExternalOrigin(request, options.publicOrigin);
        const body = await readIncomingBody(request, MAX_AUTH_PROXY_BODY_BYTES);
        const result = await rawUpstreamRequest(options.upstreams.python, "/api/v1/auth/logout", {
          method: "POST",
          headers: copyRequestHeaders(request, { origin: options.publicOrigin || options.upstreams.python }),
          body: body.length ? body : Buffer.from("{}")
        });
        const headers = responseHeadersForClient(result.headers, "python");
        response.writeHead(result.statusCode === 200 ? 204 : result.statusCode, headers);
        response.end();
        return;
      }
      if (pathname.startsWith("/blockly/")) {
        const isApiRequest = pathname.startsWith("/blockly/api/");
        const user = isApiRequest ? await pythonCurrentUser(request, options) : null;
        const needsMapBundle = pathname === "/blockly/api/records" && request.method === "POST";
        const upstreamPath = `${pathname.slice("/blockly".length)}${url.search}`;
        if (!isApiRequest && STATIC_STREAM_PATH_PATTERN.test(pathname)) {
          await proxyStreamed(request, response, options, {
            scope: "blockly",
            upstreamPath,
            cacheControl: "public, max-age=3600"
          });
          return;
        }
        const cacheControl = isApiRequest
          ? "no-store, max-age=0"
          : textAssetCacheControl(pathname, url.searchParams);
        await proxyBuffered(request, response, options, {
          scope: "blockly",
          upstreamPath,
          principal: user,
          maps: needsMapBundle ? await blocklyMapsForRequest(request, options, user) : null,
          cacheControl,
          headAsGet: cacheControl.startsWith("public,"),
          timeoutMs: isApiRequest ? 120_000 : 15_000
        });
        return;
      }

      if (pathname.startsWith("/api/competition")) {
        const user = await pythonCurrentUser(request, options);
        await proxyBuffered(request, response, options, {
          scope: "workshop",
          upstreamPath: `${pathname}${url.search}`,
          principal: user,
          timeoutMs: request.method === "GET" ? 30_000 : 120_000
        });
        return;
      }
      if (pathname.startsWith("/_next/") || pathname.startsWith("/models/") || isWorkshopAssetPath(pathname)) {
        const immutable = pathname.startsWith("/_next/static/");
        const cacheControl = immutable
          ? "public, max-age=31536000, immutable"
          : pathname.startsWith("/models/") ? "public, max-age=86400" : "no-store, max-age=0";
        if (STATIC_STREAM_PATH_PATTERN.test(pathname)) {
          await proxyStreamed(request, response, options, {
            scope: "workshop",
            upstreamPath: `${pathname}${url.search}`,
            cacheControl
          });
        } else {
          await proxyBuffered(request, response, options, {
            scope: "workshop",
            upstreamPath: `${pathname}${url.search}`,
            cacheControl
          });
        }
        return;
      }
      if (pathname === "/workshop" || pathname.startsWith("/workshop/")) {
        let user;
        try {
          user = await pythonCurrentUser(request, options);
        } catch (error) {
          if (error?.statusCode === 401 && ["GET", "HEAD"].includes(request.method)) {
            redirectPageToCentralLogin(response, `${pathname}${url.search}`);
            return;
          }
          throw error;
        }
        const suffix = pathname === "/workshop" ? "/" : pathname.slice("/workshop".length);
        await proxyBuffered(request, response, options, {
          scope: "workshop",
          upstreamPath: `${suffix}${url.search}`,
          principal: user
        });
        return;
      }

      throw new PlatformHttpError(404, "NOT_FOUND", "页面或接口不存在。");
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
      const code = typeof error?.code === "string" ? error.code : "PLATFORM_ERROR";
      const message = error instanceof PlatformHttpError ? error.message : "统一平台暂时无法完成请求。";
      jsonBody(response, statusCode, platformError(code, message), error?.headers || {});
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 125_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

function startServer(config = {}) {
  const host = config.host || process.env.HOST || DEFAULT_HOST;
  const port = positivePort(config.port ?? process.env.PORT, DEFAULT_PORT);
  const server = createServer(config);
  server.listen({ port, host, backlog: 2048 }, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    process.stdout.write(`${JSON.stringify({
      status: "listening",
      url: `http://${host}:${actualPort}/`,
      authoritative: false
    })}\n`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  PLATFORM_SCHEMA_VERSION,
  ADMIN_OVERVIEW_SCHEMA_VERSION,
  PERSONAL_SCORES_SCHEMA_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_UPSTREAMS,
  ADMIN_PAGE_SIZE,
  PlatformHttpError,
  assertExternalOrigin,
  normalizedIp,
  normalizedTrustedProxyIps,
  clientIpForRequest,
  isWorkshopAssetPath,
  mapLayoutForBlockly,
  assignedVariantId,
  highestScores,
  mergeTaskScores,
  combinedScore,
  buildAdminRows,
  paginate,
  rewriteLocation,
  rewriteTextBody,
  createServer,
  startServer
};
