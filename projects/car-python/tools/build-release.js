"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_MANIFEST_FILENAME,
  RELEASE_PAYLOAD_FILES,
  checkReleaseDirectory,
  defaultReleaseDirectory,
  productionPackageShape,
  sha256File
} = require("./check-release.js");

const SOURCE_ROOT = path.resolve(__dirname, "..");
const SOURCE_PACKAGE_PATH = path.join(SOURCE_ROOT, "package.json");

class ReleaseBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseBuildError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseBuildError(code, message);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function lstatOrNull(filename) {
  try {
    return await fs.promises.lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertOrdinarySourceFile(sourceRoot, portablePath) {
  let current = sourceRoot;
  for (const [index, component] of portablePath.split("/").entries()) {
    current = path.join(current, component);
    const stat = await lstatOrNull(current);
    if (!stat) fail("RELEASE_SOURCE_MISSING", `release source file is missing: ${portablePath}`);
    if (stat.isSymbolicLink()) {
      fail("RELEASE_SOURCE_SYMLINK", `release source path contains a symbolic link: ${portablePath}`);
    }
    const final = index === portablePath.split("/").length - 1;
    if (final ? !stat.isFile() : !stat.isDirectory()) {
      fail("RELEASE_SOURCE_INVALID", `release source path is not an ordinary file tree: ${portablePath}`);
    }
  }
  const realRoot = await fs.promises.realpath(sourceRoot);
  const realFile = await fs.promises.realpath(current);
  if (!pathIsInside(realRoot, realFile)) {
    fail("RELEASE_SOURCE_ESCAPE", `release source resolves outside the source root: ${portablePath}`);
  }
  return current;
}

async function writeProductionPackage(stagingDirectory, sourcePackage) {
  const productionPackage = productionPackageShape(sourcePackage.version);
  const filename = path.join(stagingDirectory, "package.json");
  await fs.promises.writeFile(filename, `${JSON.stringify(productionPackage, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644
  });
}

async function createManifest(stagingDirectory, sourcePackage) {
  const files = [];
  for (const portablePath of RELEASE_PAYLOAD_FILES) {
    const filename = path.join(stagingDirectory, ...portablePath.split("/"));
    const stat = await fs.promises.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail("RELEASE_STAGING_INVALID", `staged payload is not an ordinary file: ${portablePath}`);
    }
    files.push({
      path: portablePath,
      bytes: stat.size,
      sha256: await sha256File(filename)
    });
  }
  files.sort((left, right) => comparePaths(left.path, right.path));
  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    name: sourcePackage.name,
    version: sourcePackage.version,
    entrypoint: "server.js",
    nodeEngine: sourcePackage.engines.node,
    files
  };
  await fs.promises.writeFile(
    path.join(stagingDirectory, RELEASE_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o644 }
  );
  return manifest;
}

async function safeRemoveStaging(stagingDirectory, parentDirectory, prefix) {
  if (!stagingDirectory) return;
  const resolved = path.resolve(stagingDirectory);
  if (path.dirname(resolved) !== path.resolve(parentDirectory) || !path.basename(resolved).startsWith(prefix)) {
    fail("RELEASE_STAGING_CLEANUP_REFUSED", `refusing to remove an unrecognized staging directory: ${resolved}`);
  }
  await fs.promises.rm(resolved, { recursive: true, force: true });
}

async function buildRelease(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || SOURCE_ROOT);
  if (sourceRoot !== SOURCE_ROOT) {
    fail("RELEASE_SOURCE_ROOT_INVALID", "release builds must use the repository source root");
  }
  const outputDirectory = path.resolve(options.outputDirectory || options.outputDir || defaultReleaseDirectory());
  if (outputDirectory === sourceRoot || pathIsInside(outputDirectory, sourceRoot)) {
    fail("RELEASE_OUTPUT_UNSAFE", "release output cannot be the source root or one of its ancestors");
  }
  if (await lstatOrNull(outputDirectory)) {
    fail("RELEASE_OUTPUT_EXISTS", `release output already exists and will not be overwritten: ${outputDirectory}`);
  }

  let sourcePackage;
  try {
    sourcePackage = JSON.parse(await fs.promises.readFile(SOURCE_PACKAGE_PATH, "utf8"));
  } catch (_error) {
    fail("RELEASE_SOURCE_PACKAGE_INVALID", "source package.json is not valid JSON");
  }
  if (sourcePackage.name !== productionPackageShape(sourcePackage.version).name
    || sourcePackage.version !== productionPackageShape(sourcePackage.version).version
    || sourcePackage.engines?.node !== productionPackageShape(sourcePackage.version).engines.node) {
    fail("RELEASE_SOURCE_PACKAGE_INVALID", "source package identity or Node engine is invalid");
  }

  const parentDirectory = path.dirname(outputDirectory);
  const stagingPrefix = `.${path.basename(outputDirectory)}.staging-`;
  await fs.promises.mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = await fs.promises.mkdtemp(path.join(parentDirectory, stagingPrefix));
  let completed = false;
  try {
    const stagingEntries = await fs.promises.readdir(stagingDirectory);
    if (stagingEntries.length !== 0) fail("RELEASE_STAGING_NOT_EMPTY", "new release staging directory is not empty");

    for (const portablePath of RELEASE_PAYLOAD_FILES) {
      if (portablePath === "package.json") continue;
      const source = await assertOrdinarySourceFile(sourceRoot, portablePath);
      const destination = path.join(stagingDirectory, ...portablePath.split("/"));
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    }
    await writeProductionPackage(stagingDirectory, sourcePackage);
    const manifest = await createManifest(stagingDirectory, sourcePackage);
    await checkReleaseDirectory(stagingDirectory);

    if (await lstatOrNull(outputDirectory)) {
      fail("RELEASE_OUTPUT_EXISTS", `release output appeared while staging and will not be overwritten: ${outputDirectory}`);
    }
    await fs.promises.rename(stagingDirectory, outputDirectory);
    completed = true;
    return Object.freeze({
      directory: outputDirectory,
      name: sourcePackage.name,
      version: sourcePackage.version,
      payloadFileCount: manifest.files.length,
      totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      manifest
    });
  } finally {
    if (!completed) await safeRemoveStaging(stagingDirectory, parentDirectory, stagingPrefix);
  }
}

function parseCliArguments(argv) {
  let outputDirectory = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      if (outputDirectory !== null || index + 1 >= argv.length) fail("RELEASE_ARGUMENT_INVALID", "--out requires one path");
      outputDirectory = argv[++index];
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, outputDirectory: null };
    } else {
      fail("RELEASE_ARGUMENT_INVALID", `unknown release build argument: ${argument}`);
    }
  }
  return { help: false, outputDirectory: path.resolve(outputDirectory || defaultReleaseDirectory()) };
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node tools/build-release.js [--out PATH]\n");
    return;
  }
  const result = await buildRelease({ outputDirectory: options.outputDirectory });
  process.stdout.write(`${JSON.stringify({
    status: "built",
    directory: result.directory,
    name: result.name,
    version: result.version,
    payloadFileCount: result.payloadFileCount,
    totalBytes: result.totalBytes
  })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[release:build] ${error.code ? `${error.code}: ` : ""}${error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ReleaseBuildError,
  buildRelease,
  createManifest,
  safeRemoveStaging,
  writeProductionPackage
};
