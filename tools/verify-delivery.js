#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { excluded, verifySanitizedState } = require("./build-delivery.js");

const MANIFEST_SCHEMA = "chenlong.delivery-manifest/v1";
const SNAPSHOT_SCHEMA = "chenlong.delivery-snapshot/v1";

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validatedRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error(`invalid manifest path: ${JSON.stringify(value)}`);
  }
  if (/^[A-Za-z]:/u.test(value) || value.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`unsafe manifest path: ${JSON.stringify(value)}`);
  }
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) {
    throw new Error(`non-canonical manifest path: ${JSON.stringify(value)}`);
  }
  return value;
}

function allFiles(directory) {
  const files = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`delivery contains a symbolic link: ${fullPath}`);
      if (stat.isDirectory()) walk(fullPath);
      else if (stat.isFile()) files.push(fullPath);
      else throw new Error(`delivery contains an unsupported filesystem entry: ${fullPath}`);
    }
  };
  walk(directory);
  return files;
}

function verifyExtractedDelivery(deliveryRoot) {
  const resolvedRoot = path.resolve(deliveryRoot);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("delivery root must be a real directory");
  }
  const manifestPath = path.join(resolvedRoot, "DELIVERY-MANIFEST.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== MANIFEST_SCHEMA || !Array.isArray(manifest.files)) {
    throw new Error("unsupported or malformed delivery manifest");
  }
  if (!Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0
    || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) {
    throw new Error("delivery manifest has invalid totals");
  }

  const entries = new Map();
  let declaredBytes = 0;
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object") throw new Error("delivery manifest contains a malformed entry");
    const relativePath = validatedRelativePath(entry.path);
    if (relativePath === "DELIVERY-MANIFEST.json" || entries.has(relativePath)) {
      throw new Error(`duplicate or self-referential manifest path: ${relativePath}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new Error(`invalid manifest metadata: ${relativePath}`);
    }
    if (excluded(relativePath, true)) throw new Error(`manifest contains prohibited content: ${relativePath}`);
    entries.set(relativePath, entry);
    declaredBytes += entry.size;
    if (!Number.isSafeInteger(declaredBytes)) throw new Error("delivery manifest byte total is unsafe");
  }
  if (entries.size !== manifest.fileCount || declaredBytes !== manifest.totalBytes) {
    throw new Error("delivery manifest totals do not match its entries");
  }

  const actualFiles = allFiles(resolvedRoot);
  const actualPaths = actualFiles
    .map(filePath => path.relative(resolvedRoot, filePath).split(path.sep).join("/"))
    .filter(relativePath => relativePath !== "DELIVERY-MANIFEST.json");
  const actualPathSet = new Set(actualPaths);
  if (actualPathSet.size !== actualPaths.length) throw new Error("delivery contains duplicate file paths");
  if (actualPaths.length !== entries.size) {
    throw new Error(`delivery file count mismatch: expected ${entries.size}, found ${actualPaths.length}`);
  }
  for (const relativePath of actualPaths) {
    validatedRelativePath(relativePath);
    const entry = entries.get(relativePath);
    if (!entry) throw new Error(`delivery contains an unlisted file: ${relativePath}`);
    const filePath = path.join(resolvedRoot, ...relativePath.split("/"));
    const size = fs.statSync(filePath).size;
    if (size !== entry.size) throw new Error(`delivery size mismatch: ${relativePath}`);
    const digest = sha256(filePath);
    if (digest !== entry.sha256) throw new Error(`delivery SHA256 mismatch: ${relativePath}`);
  }
  for (const relativePath of entries.keys()) {
    if (!actualPathSet.has(relativePath)) throw new Error(`delivery is missing a manifest file: ${relativePath}`);
  }

  const snapshotPath = path.join(resolvedRoot, "DELIVERY-SNAPSHOT.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA || snapshot.sourceRoot !== "redacted") {
    throw new Error("delivery snapshot is unsupported or exposes the source path");
  }
  verifySanitizedState(resolvedRoot);
  return {
    fileCount: entries.size,
    totalBytes: declaredBytes,
    createdAt: manifest.createdAt,
    includesDependencies: Boolean(snapshot.includesDependencies)
  };
}

function readExpectedArchiveHash(zipPath) {
  const checksumPath = `${zipPath}.sha256`;
  const checksum = fs.readFileSync(checksumPath, "utf8");
  const match = /^([0-9a-f]{64})  ([^\r\n]+)\r?\n?$/u.exec(checksum);
  if (!match || match[2] !== path.basename(zipPath)) {
    throw new Error(`malformed SHA256 sidecar: ${checksumPath}`);
  }
  return { checksumPath, expectedHash: match[1] };
}

function listArchive(zipPath) {
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  const result = childProcess.spawnSync(tar, ["-tf", zipPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cannot list delivery archive: ${result.stderr || result.status}`);
  const seen = new Set();
  let hasManifest = false;
  for (const rawEntry of result.stdout.split(/\r?\n/u).filter(Boolean)) {
    const entry = rawEntry.endsWith("/") ? rawEntry.slice(0, -1) : rawEntry;
    if (entry !== "competition-platform" && !entry.startsWith("competition-platform/")) {
      throw new Error(`archive entry is outside competition-platform: ${rawEntry}`);
    }
    if (entry !== "competition-platform") validatedRelativePath(entry.slice("competition-platform/".length));
    if (seen.has(rawEntry)) throw new Error(`archive contains a duplicate entry: ${rawEntry}`);
    seen.add(rawEntry);
    if (entry === "competition-platform/DELIVERY-MANIFEST.json") hasManifest = true;
  }
  if (!hasManifest) throw new Error("archive does not contain DELIVERY-MANIFEST.json");
}

function verifyArchive(archivePath) {
  const zipPath = path.resolve(archivePath);
  const zipStat = fs.lstatSync(zipPath);
  if (zipStat.isSymbolicLink() || !zipStat.isFile()) throw new Error("delivery archive must be a real file");
  const { checksumPath, expectedHash } = readExpectedArchiveHash(zipPath);
  const actualHash = sha256(zipPath);
  if (actualHash !== expectedHash) throw new Error(`archive SHA256 mismatch: ${zipPath}`);
  listArchive(zipPath);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-delivery-verify-"));
  try {
    const tar = process.platform === "win32" ? "tar.exe" : "tar";
    const result = childProcess.spawnSync(tar, ["-xf", zipPath], {
      cwd: temporaryRoot,
      stdio: "pipe",
      shell: false
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`cannot extract delivery archive: ${result.stderr || result.status}`);
    const topLevel = fs.readdirSync(temporaryRoot);
    if (topLevel.length !== 1 || topLevel[0] !== "competition-platform") {
      throw new Error("delivery archive has an unexpected top-level layout");
    }
    const resultSummary = verifyExtractedDelivery(path.join(temporaryRoot, "competition-platform"));
    if (sha256(zipPath) !== expectedHash) throw new Error("delivery archive changed while it was being verified");
    return { ...resultSummary, zipPath, checksumPath, sha256: actualHash, archiveBytes: zipStat.size };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length !== 1) throw new TypeError("usage: node tools/verify-delivery.js <delivery.zip>");
  const result = verifyArchive(argumentsList[0]);
  process.stdout.write(`${JSON.stringify({ status: "verified", ...result }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`delivery verification failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { readExpectedArchiveHash, validatedRelativePath, verifyArchive, verifyExtractedDelivery };
