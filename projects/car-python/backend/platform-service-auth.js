"use strict";

// Kept inside the independently deliverable Python project. The unified
// gateway implements the same small wire contract in packages/internal-service-auth.js.
const crypto = require("node:crypto");
const net = require("node:net");

const SERVICE_HEADER = "x-chenlong-platform-service";
const VERSION = "v1";
const CLOCK_TOLERANCE_SECONDS = 30;

function requireSecret(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new TypeError("internal platform service secret must contain at least 32 UTF-8 bytes");
  }
  return value;
}

function normalizedPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096
    || /[\r\n\0]/.test(value)) throw new TypeError("internal service request path is invalid");
  return value;
}

function signedText(method, requestPath, timestamp, nonce) {
  return `${method}\n${normalizedPath(requestPath)}\n${timestamp}\n${nonce}`;
}

function signature(secret, text) {
  return crypto.createHmac("sha256", requireSecret(secret)).update(text, "utf8").digest("base64url");
}

function signServiceRequest(secret, requestPath, {
  method = "GET",
  nowSeconds = Math.floor(Date.now() / 1000),
  nonce = crypto.randomBytes(16).toString("base64url")
} = {}) {
  if (method !== "GET" || !Number.isSafeInteger(nowSeconds) || !/^\d{10}$/.test(String(nowSeconds))
    || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) {
    throw new TypeError("internal service request claims are invalid");
  }
  const text = signedText(method, requestPath, nowSeconds, nonce);
  return `${VERSION}.${nowSeconds}.${nonce}.${signature(secret, text)}`;
}

function safeEqual(left, right) {
  const actual = Buffer.from(left, "ascii");
  const expected = Buffer.from(right, "ascii");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

class ServiceReplayWindow {
  constructor({ nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
    this.nowSeconds = nowSeconds;
    this.used = new Map();
  }

  consume(key, expiresAt) {
    const now = this.nowSeconds();
    for (const [candidate, expiry] of this.used) if (expiry <= now) this.used.delete(candidate);
    if (this.used.has(key)) throw new TypeError("internal service request was already used");
    this.used.set(key, expiresAt);
  }
}

function verifyServiceRequest(value, secret, requestPath, replayWindow, {
  method = "GET",
  nowSeconds = Math.floor(Date.now() / 1000)
} = {}) {
  if (typeof value !== "string" || value.length > 256 || method !== "GET") {
    throw new TypeError("internal service authentication is invalid");
  }
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || !/^\d{10}$/.test(parts[1])
    || !/^[A-Za-z0-9_-]{22}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) {
    throw new TypeError("internal service authentication is invalid");
  }
  const timestamp = Number(parts[1]);
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - timestamp) > CLOCK_TOLERANCE_SECONDS) {
    throw new TypeError("internal service authentication is expired");
  }
  const expected = signature(secret, signedText(method, requestPath, timestamp, parts[2]));
  if (!safeEqual(parts[3], expected)) throw new TypeError("internal service authentication is invalid");
  if (!replayWindow || typeof replayWindow.consume !== "function") {
    throw new TypeError("internal service replay window is required");
  }
  replayWindow.consume(`${timestamp}:${parts[2]}:${parts[3]}`, timestamp + CLOCK_TOLERANCE_SECONDS + 1);
  return Object.freeze({ timestamp, nonce: parts[2] });
}

function loopbackAddress(value) {
  if (typeof value !== "string") return false;
  let address = value.toLowerCase().split("%", 1)[0];
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (net.isIP(address) === 4) return address.startsWith("127.");
  return address === "::1";
}

module.exports = Object.freeze({
  SERVICE_HEADER,
  CLOCK_TOLERANCE_SECONDS,
  ServiceReplayWindow,
  signServiceRequest,
  verifyServiceRequest,
  loopbackAddress
});
