"use strict";

const crypto = require("node:crypto");

function canonicalJson(value, stack = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not support non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== "object") throw new TypeError("canonical JSON contains an unsupported value");
  if (stack.has(value)) throw new TypeError("canonical JSON cannot contain cycles");
  stack.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, stack)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON only accepts plain objects");
    }
    const entries = Object.keys(value).sort().map(key => {
      const item = value[key];
      if (item === undefined) throw new TypeError("canonical JSON does not support undefined values");
      return `${JSON.stringify(key)}:${canonicalJson(item, stack)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function canonicalSha256(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

module.exports = { canonicalJson, canonicalSha256 };
