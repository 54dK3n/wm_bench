"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SOURCE_ROOT = path.resolve(__dirname, "..");
const SOURCE_PACKAGE = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8"));
const RELEASE_MANIFEST_SCHEMA_VERSION = "chenlong.release-manifest/v1";
const RELEASE_MANIFEST_FILENAME = "release-manifest.json";
const INTEGRATION_NAVIGATION_PATHS = Object.freeze(["/portal.html"]);

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const RELEASE_PAYLOAD_FILES = Object.freeze([
  "DELIVERY.md",
  "account.css",
  "admin.html",
  "admin-team-scores.js",
  "admin.js",
  "app.js",
  "auth-guard.js",
  "auth.js",
  "backend/auth-store.js",
  "backend/batch-evaluation-core.js",
  "backend/batch-evaluation-store.js",
  "backend/canonical-json.js",
  "backend/guangyang-map-config-store.js",
  "backend/guangyang-map-pool.js",
  "backend/guangyang-private-layout-catalog.js",
  "backend/official-sso.js",
  "backend/platform-service-auth.js",
  "backend/record-capability-usage.js",
  "backend/strict-png.js",
  "backend/submission-store.js",
  "backend/vision-recompute.js",
  "competition-core.js",
  "index.html",
  "login.html",
  "package.json",
  "python-worker.js",
  "records.html",
  "records.js",
  "server.js",
  "styles.css",
  "tools/verify-run-record-worker.js",
  "tools/verify-run-record.js",
  "vendor/lucide/lucide.min.js",
  "vendor/pyodide/pyodide-lock.json",
  "vendor/pyodide/pyodide.asm.js",
  "vendor/pyodide/pyodide.asm.wasm",
  "vendor/pyodide/pyodide.js",
  "vendor/pyodide/python_stdlib.zip",
  "vendor/three/three.min.js",
  "vendor/vision/ort-wasm-simd-threaded.mjs",
  "vendor/vision/ort-wasm-simd-threaded.wasm",
  "vendor/vision/ort.min.js",
  "vendor/vision/yolov8n-fp16.onnx",
  "vision-pixel-core.js",
  "vision.js",
  "word/广阳岛仿真沙盘地图.png"
].sort(comparePaths));

const PUBLIC_ROOT_FILES = Object.freeze([
  "account.css",
  "admin.html",
  "admin-team-scores.js",
  "admin.js",
  "app.js",
  "auth-guard.js",
  "auth.js",
  "competition-core.js",
  "index.html",
  "login.html",
  "python-worker.js",
  "records.html",
  "records.js",
  "styles.css",
  "vision-pixel-core.js",
  "vision.js"
].sort(comparePaths));

const FORBIDDEN_COMPONENTS = new Set([
  ".runtime",
  "__pycache__",
  "docs",
  "examples",
  "log",
  "logs",
  "tests"
]);

class ReleaseCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseCheckError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseCheckError(code, message);
}

function toPosixPath(value) {
  return String(value).split(path.sep).join("/");
}

function assertPortableReleasePath(value, label = "release path") {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
    fail("RELEASE_PATH_INVALID", `${label} must be a non-empty POSIX path`);
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || path.posix.normalize(value) !== value) {
    fail("RELEASE_PATH_ESCAPE", `${label} is absolute, non-canonical or escapes the release root: ${value}`);
  }
  const components = value.split("/");
  if (components.some(component => !component || component === "." || component === "..")) {
    fail("RELEASE_PATH_ESCAPE", `${label} contains an unsafe component: ${value}`);
  }
  const lowerComponents = components.map(component => component.toLowerCase());
  if (lowerComponents.some(component => FORBIDDEN_COMPONENTS.has(component))) {
    fail("RELEASE_PATH_FORBIDDEN", `${label} contains a forbidden directory: ${value}`);
  }
  const basename = lowerComponents.at(-1);
  if (basename === ".chenlong-writer.lock" || basename.endsWith(".pyc")
    || basename.endsWith(".log") || basename.endsWith(".lock")) {
    fail("RELEASE_PATH_FORBIDDEN", `${label} is a forbidden cache, log or lock file: ${value}`);
  }
  return value;
}

function expectedDirectories() {
  const directories = new Set([""]);
  for (const filename of [...RELEASE_PAYLOAD_FILES, RELEASE_MANIFEST_FILENAME]) {
    let current = path.posix.dirname(filename);
    while (current && current !== ".") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return directories;
}

async function inspectReleaseTree(rootDirectory) {
  let rootStat;
  try {
    rootStat = await fs.promises.lstat(rootDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") fail("RELEASE_DIRECTORY_MISSING", `release directory does not exist: ${rootDirectory}`);
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("RELEASE_DIRECTORY_INVALID", "release root must be a real directory, not a symlink");
  }

  const allowedDirectories = expectedDirectories();
  const files = [];
  const visit = async (absoluteDirectory, relativeDirectory = "") => {
    const entries = await fs.promises.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertPortableReleasePath(relativePath, "release tree path");
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        fail("RELEASE_SYMLINK_FORBIDDEN", `release tree contains a symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) {
          fail("RELEASE_EXTRA_DIRECTORY", `release tree contains an extra directory: ${relativePath}`);
        }
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        fail("RELEASE_SPECIAL_FILE_FORBIDDEN", `release tree contains a non-regular file: ${relativePath}`);
      }
      files.push({ path: relativePath, absolutePath, stat });
    }
  };
  await visit(rootDirectory);
  files.sort((left, right) => comparePaths(left.path, right.path));
  return files;
}

async function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filename);
    stream.once("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function productionPackageShape(version = SOURCE_PACKAGE.version) {
  return {
    name: SOURCE_PACKAGE.name,
    version,
    private: true,
    description: SOURCE_PACKAGE.description,
    engines: { node: SOURCE_PACKAGE.engines.node },
    scripts: { start: "node server.js" }
  };
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RELEASE_MANIFEST_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(comparePaths);
  const wanted = [...expected].sort(comparePaths);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail("RELEASE_MANIFEST_INVALID", `${label} has unexpected fields: ${actual.join(", ")}`);
  }
}

function parseAndValidateManifest(source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (_error) {
    fail("RELEASE_MANIFEST_INVALID", "release manifest is not valid JSON");
  }
  exactObjectKeys(manifest, ["schemaVersion", "name", "version", "entrypoint", "nodeEngine", "files"], "release manifest");
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION
    || manifest.name !== SOURCE_PACKAGE.name
    || manifest.version !== SOURCE_PACKAGE.version
    || manifest.entrypoint !== "server.js"
    || manifest.nodeEngine !== SOURCE_PACKAGE.engines.node
    || !Array.isArray(manifest.files)) {
    fail("RELEASE_MANIFEST_INVALID", "release manifest identity or runtime contract does not match the source package");
  }
  if (manifest.files.length !== RELEASE_PAYLOAD_FILES.length) {
    fail("RELEASE_MANIFEST_FILESET_MISMATCH", `release manifest must contain exactly ${RELEASE_PAYLOAD_FILES.length} payload files`);
  }
  const paths = [];
  const seen = new Set();
  for (const [index, file] of manifest.files.entries()) {
    exactObjectKeys(file, ["path", "bytes", "sha256"], `manifest file ${index}`);
    const filename = assertPortableReleasePath(file.path, `manifest file ${index}`);
    if (seen.has(filename)) fail("RELEASE_MANIFEST_DUPLICATE", `release manifest repeats ${filename}`);
    seen.add(filename);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || "")) {
      fail("RELEASE_MANIFEST_INVALID", `release manifest has invalid size or SHA-256 for ${filename}`);
    }
    paths.push(filename);
  }
  const sorted = [...paths].sort(comparePaths);
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) {
    fail("RELEASE_MANIFEST_ORDER", "release manifest file paths must be sorted in POSIX lexical order");
  }
  if (JSON.stringify(paths) !== JSON.stringify(RELEASE_PAYLOAD_FILES)) {
    fail("RELEASE_MANIFEST_FILESET_MISMATCH", "release manifest payload paths do not match the fixed release allowlist");
  }
  return manifest;
}

function resolveLocalReference(fromFile, reference) {
  const clean = String(reference).split("#", 1)[0].split("?", 1)[0];
  if (!clean.startsWith(".")) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
  assertPortableReleasePath(resolved, `local reference from ${fromFile}`);
  return resolved;
}

function assertReferenceIncluded(expectedFiles, fromFile, reference) {
  const resolved = resolveLocalReference(fromFile, reference);
  if (resolved && !expectedFiles.has(resolved)) {
    fail("RELEASE_STATIC_CLOSURE", `${fromFile} references a file outside the release payload: ${reference}`);
  }
}

function assertContains(source, needle, filename) {
  if (!source.includes(needle)) {
    fail("RELEASE_STATIC_CLOSURE", `${filename} is missing required runtime reference ${needle}`);
  }
}

async function validateStaticClosure(rootDirectory) {
  const expectedFiles = new Set(RELEASE_PAYLOAD_FILES);
  const textByFile = new Map();
  const readText = async filename => {
    if (!textByFile.has(filename)) {
      textByFile.set(filename, await fs.promises.readFile(path.join(rootDirectory, ...filename.split("/")), "utf8"));
    }
    return textByFile.get(filename);
  };

  for (const filename of RELEASE_PAYLOAD_FILES.filter(value => value.endsWith(".js") && !value.startsWith("vendor/"))) {
    const source = await readText(filename);
    for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      const reference = match[1];
      if (reference.startsWith("node:")) continue;
      assertReferenceIncluded(expectedFiles, filename, reference);
    }
    for (const match of source.matchAll(/\bnew\s+Worker\(\s*["']([^"']+)["']/g)) {
      assertReferenceIncluded(expectedFiles, filename, match[1]);
    }
  }

  for (const filename of RELEASE_PAYLOAD_FILES.filter(value => value.endsWith(".html"))) {
    const source = await readText(filename);
    for (const match of source.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      const reference = match[1];
      if (/^(?:https?:|data:|blob:|mailto:|#)/i.test(reference)) continue;
      const url = new URL(reference, `https://release.invalid/${filename}`);
      if (url.origin !== "https://release.invalid" || url.pathname.startsWith("/api/")) continue;
      if (INTEGRATION_NAVIGATION_PATHS.includes(url.pathname)) continue;
      const referencedPath = decodeURIComponent(url.pathname.replace(/^\/+/, "")) || "index.html";
      assertPortableReleasePath(referencedPath, `HTML reference from ${filename}`);
      if (!expectedFiles.has(referencedPath)) {
        fail("RELEASE_STATIC_CLOSURE", `${filename} references a missing static asset: ${reference}`);
      }
    }
  }

  for (const filename of RELEASE_PAYLOAD_FILES.filter(value => value.endsWith(".css"))) {
    const source = await readText(filename);
    for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const reference = match[1];
      if (/^(?:https?:|data:|blob:|#)/i.test(reference)) continue;
      assertReferenceIncluded(expectedFiles, filename, reference);
    }
  }

  const serverSource = await readText("server.js");
  const staticBlock = /const TOP_LEVEL_STATIC_FILES = new Set\(\[([\s\S]*?)\]\);/.exec(serverSource)?.[1] || "";
  const servedRootFiles = [...staticBlock.matchAll(/["']([^"']+)["']/g)]
    .map(match => match[1])
    .sort(comparePaths);
  if (JSON.stringify(servedRootFiles) !== JSON.stringify(PUBLIC_ROOT_FILES)) {
    fail("RELEASE_STATIC_CLOSURE", "server static root allowlist does not match the release public root files");
  }

  const workerSource = await readText("python-worker.js");
  ["./vendor/pyodide/", "pyodide.js", "pyodide.asm.js", "python_stdlib.zip"].forEach(value => {
    assertContains(workerSource, value, "python-worker.js");
  });
  const visionSource = await readText("vision.js");
  ["./vendor/vision/yolov8n-fp16.onnx", "./vendor/vision/"].forEach(value => {
    assertContains(visionSource, value, "vision.js");
  });
  const competitionSource = await readText("competition-core.js");
  assertContains(competitionSource, "./word/广阳岛仿真沙盘地图.png", "competition-core.js");
  ["verify-run-record-worker.js", "word/广阳岛仿真沙盘地图.png"].forEach(value => {
    assertContains(serverSource, value, "server.js");
  });
}

function runNodeSyntaxChecks(rootDirectory) {
  const scripts = RELEASE_PAYLOAD_FILES.filter(filename => /\.(?:js|mjs)$/.test(filename));
  for (const filename of scripts) {
    const absolutePath = path.join(rootDirectory, ...filename.split("/"));
    const checked = spawnSync(process.execPath, ["--check", absolutePath], {
      cwd: rootDirectory,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    if (checked.error || checked.status !== 0) {
      const detail = String(checked.stderr || checked.stdout || checked.error?.message || "syntax check failed").trim();
      fail("RELEASE_JAVASCRIPT_INVALID", `${filename} failed node --check: ${detail.slice(0, 600)}`);
    }
  }
}

async function checkReleaseDirectory(directory, options = {}) {
  const rootDirectory = path.resolve(directory);
  const tree = await inspectReleaseTree(rootDirectory);
  const actualPaths = tree.map(entry => entry.path);
  const expectedTreePaths = [...RELEASE_PAYLOAD_FILES, RELEASE_MANIFEST_FILENAME]
    .sort(comparePaths);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedTreePaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedTreePaths);
    const missing = expectedTreePaths.filter(filename => !actual.has(filename));
    const extra = actualPaths.filter(filename => !expected.has(filename));
    fail(
      "RELEASE_TREE_MISMATCH",
      `release tree differs from the fixed allowlist; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`
    );
  }

  const manifestPath = path.join(rootDirectory, RELEASE_MANIFEST_FILENAME);
  const manifestStat = await fs.promises.lstat(manifestPath);
  if (manifestStat.size < 2 || manifestStat.size > 1024 * 1024) {
    fail("RELEASE_MANIFEST_INVALID", "release manifest size is invalid");
  }
  const manifest = parseAndValidateManifest(await fs.promises.readFile(manifestPath, "utf8"));
  const entriesByPath = new Map(tree.map(entry => [entry.path, entry]));
  let totalBytes = 0;
  for (const expected of manifest.files) {
    const actual = entriesByPath.get(expected.path);
    if (!actual) fail("RELEASE_FILE_MISSING", `release payload is missing ${expected.path}`);
    if (actual.stat.size !== expected.bytes) {
      fail("RELEASE_FILE_SIZE_MISMATCH", `${expected.path} size does not match the manifest`);
    }
    const digest = await sha256File(actual.absolutePath);
    if (digest !== expected.sha256) {
      fail("RELEASE_FILE_HASH_MISMATCH", `${expected.path} SHA-256 does not match the manifest`);
    }
    totalBytes += expected.bytes;
  }

  let packageValue;
  try {
    packageValue = JSON.parse(await fs.promises.readFile(path.join(rootDirectory, "package.json"), "utf8"));
  } catch (_error) {
    fail("RELEASE_PACKAGE_INVALID", "production package.json is not valid JSON");
  }
  if (JSON.stringify(packageValue) !== JSON.stringify(productionPackageShape(manifest.version))) {
    fail("RELEASE_PACKAGE_INVALID", "production package.json must contain only the approved metadata and start script");
  }

  await validateStaticClosure(rootDirectory);
  if (options.nodeCheck !== false) runNodeSyntaxChecks(rootDirectory);
  return Object.freeze({
    directory: rootDirectory,
    name: manifest.name,
    version: manifest.version,
    payloadFileCount: manifest.files.length,
    totalBytes,
    manifest
  });
}

function defaultReleaseDirectory() {
  return path.join(SOURCE_ROOT, "dist", `${SOURCE_PACKAGE.name}-${SOURCE_PACKAGE.version}`);
}

function parseCliArguments(argv) {
  let directory = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dir") {
      if (directory !== null || index + 1 >= argv.length) fail("RELEASE_ARGUMENT_INVALID", "--dir requires one path");
      directory = argv[++index];
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, directory: null };
    } else {
      fail("RELEASE_ARGUMENT_INVALID", `unknown release check argument: ${argument}`);
    }
  }
  return { help: false, directory: path.resolve(directory || defaultReleaseDirectory()) };
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node tools/check-release.js [--dir PATH]\n");
    return;
  }
  const result = await checkReleaseDirectory(options.directory);
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    directory: result.directory,
    name: result.name,
    version: result.version,
    payloadFileCount: result.payloadFileCount,
    totalBytes: result.totalBytes
  })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[release:check] ${error.code ? `${error.code}: ` : ""}${error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_MANIFEST_FILENAME,
  INTEGRATION_NAVIGATION_PATHS,
  RELEASE_PAYLOAD_FILES,
  PUBLIC_ROOT_FILES,
  ReleaseCheckError,
  assertPortableReleasePath,
  checkReleaseDirectory,
  defaultReleaseDirectory,
  productionPackageShape,
  sha256File,
  validateStaticClosure
};
