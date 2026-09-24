"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");

const { buildRelease } = require("../tools/build-release.js");
const {
  RELEASE_MANIFEST_FILENAME,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  RELEASE_PAYLOAD_FILES,
  INTEGRATION_NAVIGATION_PATHS,
  ReleaseCheckError,
  checkReleaseDirectory,
  defaultReleaseDirectory,
  productionPackageShape
} = require("../tools/check-release.js");

const sourcePackage = require("../package.json");

const TEMP_PREFIX = "chenlong-release-package-test-";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readManifest(directory) {
  return JSON.parse(await fs.promises.readFile(path.join(directory, RELEASE_MANIFEST_FILENAME), "utf8"));
}

async function writeManifest(directory, manifest) {
  await fs.promises.writeFile(
    path.join(directory, RELEASE_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

async function refreshManifestFile(directory, portablePath) {
  const manifest = await readManifest(directory);
  const entry = manifest.files.find(file => file.path === portablePath);
  assert.ok(entry, `manifest entry missing for ${portablePath}`);
  const buffer = await fs.promises.readFile(path.join(directory, ...portablePath.split("/")));
  entry.bytes = buffer.length;
  entry.sha256 = sha256(buffer);
  await writeManifest(directory, manifest);
}

async function expectReleaseError(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ReleaseCheckError || typeof error?.code === "string");
    assert.equal(error.code, code);
    return true;
  });
}

function request(origin, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(options.path || "/", origin);
    const clientRequest = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers: { Connection: "close", ...(options.headers || {}) }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    clientRequest.once("error", reject);
    if (body) clientRequest.end(body);
    else clientRequest.end();
  });
}

function waitForListening(child, stderrState) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => finish(new Error(`packaged server startup timed out: ${stderrState.value}`)), 10_000);
    const onStdout = chunk => {
      stdout += chunk.toString("utf8");
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          const payload = JSON.parse(line);
          if (payload.status === "listening" && typeof payload.url === "string") {
            finish(null, payload.url);
            return;
          }
        } catch (_error) {
          // Preserve the complete line in a bounded diagnostic if startup exits.
          stderrState.value = `${stderrState.value}\nstdout: ${line}`.slice(-4000);
        }
      }
    };
    const onExit = code => finish(new Error(`packaged server exited before listening (${code}): ${stderrState.value}`));
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", onStdout);
    child.once("exit", onExit);
  });
}

async function stopPackagedServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (child.connected) child.send({ type: "close" });
  else child.kill("SIGTERM");
  const timeout = new Promise((_, reject) => {
    const id = setTimeout(() => reject(new Error("packaged server did not stop after SIGTERM")), 8_000);
    id.unref?.();
  });
  try {
    await Promise.race([exited, timeout]);
  } catch (error) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => {});
    throw error;
  }
}

test("release build is reproducible, closed, tamper-evident, and starts in isolation", { timeout: 120_000 }, async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const firstDirectory = path.join(tempRoot, "release-a");
  const secondDirectory = path.join(tempRoot, "release-b");
  t.after(async () => {
    const resolved = path.resolve(tempRoot);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^chenlong-release-package-test-[A-Za-z0-9_-]+$/);
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });

  const first = await buildRelease({ outputDirectory: firstDirectory });
  const second = await buildRelease({ outputDirectory: secondDirectory });
  assert.equal(sourcePackage.scripts["release:build"], "node tools/build-release.js");
  assert.equal(sourcePackage.scripts["release:check"], "node tools/check-release.js");
  assert.deepEqual(INTEGRATION_NAVIGATION_PATHS, ["/portal.html"]);
  assert.equal(
    defaultReleaseDirectory(),
    path.resolve(__dirname, "..", "dist", "chenlong-car-simulator-0.4.0")
  );
  assert.equal(RELEASE_PAYLOAD_FILES.length, 51, "50 runtime files plus DELIVERY.md must be frozen");
  assert.equal(first.payloadFileCount, 51);
  assert.equal(second.payloadFileCount, 51);
  assert.equal(RELEASE_PAYLOAD_FILES.includes("backend/platform-service-auth.js"), true);
  assert.equal(RELEASE_PAYLOAD_FILES.includes("DELIVERY.md"), true);
  assert.equal(RELEASE_PAYLOAD_FILES.some(filename => /^(?:tests|examples|docs)\//.test(filename)), false);
  assert.equal(RELEASE_PAYLOAD_FILES.some(filename => /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/i.test(filename)), false);

  const firstManifestSource = await fs.promises.readFile(path.join(firstDirectory, RELEASE_MANIFEST_FILENAME), "utf8");
  const secondManifestSource = await fs.promises.readFile(path.join(secondDirectory, RELEASE_MANIFEST_FILENAME), "utf8");
  assert.equal(firstManifestSource, secondManifestSource, "identical sources must produce byte-identical manifests");
  assert.doesNotMatch(firstManifestSource, /(?:created|built|generated|timestamp).*at/i);
  const manifest = JSON.parse(firstManifestSource);
  assert.equal(manifest.schemaVersion, RELEASE_MANIFEST_SCHEMA_VERSION);
  assert.deepEqual(manifest.files.map(file => file.path), RELEASE_PAYLOAD_FILES);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(firstDirectory, "package.json"), "utf8")), productionPackageShape());
  assert.deepEqual(Object.keys(productionPackageShape().scripts), ["start"]);
  await checkReleaseDirectory(firstDirectory);

  await t.test("existing output is never overwritten", async () => {
    const before = await fs.promises.readFile(path.join(firstDirectory, RELEASE_MANIFEST_FILENAME));
    await assert.rejects(
      () => buildRelease({ outputDirectory: firstDirectory }),
      error => error?.code === "RELEASE_OUTPUT_EXISTS"
    );
    assert.deepEqual(await fs.promises.readFile(path.join(firstDirectory, RELEASE_MANIFEST_FILENAME)), before);
  });

  await t.test("missing, extra, forbidden, and modified payloads are rejected", async () => {
    const authPath = path.join(firstDirectory, "auth.js");
    const authSource = await fs.promises.readFile(authPath);
    await fs.promises.unlink(authPath);
    try {
      await expectReleaseError(() => checkReleaseDirectory(firstDirectory, { nodeCheck: false }), "RELEASE_TREE_MISMATCH");
    } finally {
      await fs.promises.writeFile(authPath, authSource);
    }

    const extraPath = path.join(firstDirectory, "unexpected.txt");
    await fs.promises.writeFile(extraPath, "unexpected\n", "utf8");
    try {
      await expectReleaseError(() => checkReleaseDirectory(firstDirectory, { nodeCheck: false }), "RELEASE_TREE_MISMATCH");
    } finally {
      await fs.promises.unlink(extraPath);
    }

    const forbiddenPaths = [
      ".runtime/probe",
      "tests/probe.js",
      "examples/probe.py",
      "docs/probe.md",
      "backend/probe.pyc",
      "probe.log",
      ".chenlong-writer.lock"
    ];
    for (const portablePath of forbiddenPaths) {
      const absolutePath = path.join(firstDirectory, ...portablePath.split("/"));
      await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.promises.writeFile(absolutePath, "forbidden\n", "utf8");
      try {
        await expectReleaseError(() => checkReleaseDirectory(firstDirectory, { nodeCheck: false }), "RELEASE_PATH_FORBIDDEN");
      } finally {
        const topComponent = portablePath.split("/")[0];
        if ([".runtime", "tests", "examples", "docs"].includes(topComponent)) {
          await fs.promises.rm(path.join(firstDirectory, topComponent), { recursive: true, force: true });
        } else {
          await fs.promises.unlink(absolutePath);
        }
      }
    }

    const appPath = path.join(firstDirectory, "app.js");
    const appSource = await fs.promises.readFile(appPath);
    const altered = Buffer.from(appSource);
    altered[0] ^= 1;
    await fs.promises.writeFile(appPath, altered);
    try {
      await expectReleaseError(() => checkReleaseDirectory(firstDirectory, { nodeCheck: false }), "RELEASE_FILE_HASH_MISMATCH");
    } finally {
      await fs.promises.writeFile(appPath, appSource);
    }
  });

  await t.test("manifest paths cannot escape and semantic checks survive a rehashed tamper", async () => {
    const manifestPath = path.join(firstDirectory, RELEASE_MANIFEST_FILENAME);
    const originalManifest = await fs.promises.readFile(manifestPath);
    const escaped = JSON.parse(originalManifest.toString("utf8"));
    escaped.files[0].path = "../escape";
    await writeManifest(firstDirectory, escaped);
    try {
      await expectReleaseError(() => checkReleaseDirectory(firstDirectory, { nodeCheck: false }), "RELEASE_PATH_ESCAPE");
    } finally {
      await fs.promises.writeFile(manifestPath, originalManifest);
    }

    const packagePath = path.join(firstDirectory, "package.json");
    const originalPackage = await fs.promises.readFile(packagePath);
    const alteredPackage = JSON.parse(originalPackage.toString("utf8"));
    alteredPackage.scripts.test = "node tests/not-shipped.js";
    await fs.promises.writeFile(packagePath, `${JSON.stringify(alteredPackage, null, 2)}\n`, "utf8");
    await refreshManifestFile(firstDirectory, "package.json");
    try {
      await expectReleaseError(() => checkReleaseDirectory(firstDirectory, { nodeCheck: false }), "RELEASE_PACKAGE_INVALID");
    } finally {
      await fs.promises.writeFile(packagePath, originalPackage);
      await fs.promises.writeFile(manifestPath, originalManifest);
    }

    const indexPath = path.join(firstDirectory, "index.html");
    const originalIndex = await fs.promises.readFile(indexPath);
    const alteredIndex = originalIndex.toString("utf8").replace("./styles.css?", "./missing.css?");
    assert.notEqual(alteredIndex, originalIndex.toString("utf8"));
    await fs.promises.writeFile(indexPath, alteredIndex, "utf8");
    await refreshManifestFile(firstDirectory, "index.html");
    try {
      await expectReleaseError(() => checkReleaseDirectory(firstDirectory, { nodeCheck: false }), "RELEASE_STATIC_CLOSURE");
    } finally {
      await fs.promises.writeFile(indexPath, originalIndex);
      await fs.promises.writeFile(manifestPath, originalManifest);
    }

    const authPath = path.join(firstDirectory, "auth.js");
    const originalAuth = await fs.promises.readFile(authPath);
    await fs.promises.writeFile(authPath, `${originalAuth.toString("utf8")}\nfunction broken( {\n`, "utf8");
    await refreshManifestFile(firstDirectory, "auth.js");
    try {
      await expectReleaseError(() => checkReleaseDirectory(firstDirectory), "RELEASE_JAVASCRIPT_INVALID");
    } finally {
      await fs.promises.writeFile(authPath, originalAuth);
      await fs.promises.writeFile(manifestPath, originalManifest);
    }
  });

  await t.test("symbolic links are rejected when the platform permits creating one", async t => {
    let linkPath = path.join(firstDirectory, "unexpected-link.js");
    try {
      await fs.promises.symlink("auth.js", linkPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        linkPath = path.join(firstDirectory, "unexpected-link-directory");
        try {
          await fs.promises.symlink(path.join(firstDirectory, "backend"), linkPath, "junction");
        } catch (junctionError) {
          if (["EPERM", "EACCES", "ENOTSUP"].includes(junctionError?.code)) {
            t.skip(`platform cannot create a file symlink or directory junction: ${junctionError.code}`);
            return;
          }
          throw junctionError;
        }
      } else {
        throw error;
      }
    }
    try {
      await expectReleaseError(() => checkReleaseDirectory(firstDirectory, { nodeCheck: false }), "RELEASE_SYMLINK_FORBIDDEN");
    } finally {
      await fs.promises.unlink(linkPath);
    }
  });

  await t.test("the packaged server starts from an unrelated cwd and loads its verification worker", async () => {
    const dataDirectory = path.join(tempRoot, "isolated-data");
    const cwdDirectory = path.join(tempRoot, "isolated-cwd");
    await fs.promises.mkdir(cwdDirectory);
    const stderrState = { value: "" };
    const packagedServerPath = path.join(secondDirectory, "server.js");
    const launcher = [
      '"use strict";',
      "const server = require(process.argv[1]).startServer();",
      "process.on('message', message => {",
      "  if (message?.type !== 'close') return;",
      "  server.close(() => process.exit(0));",
      "});"
    ].join("\n");
    const child = spawn(process.execPath, ["-e", launcher, packagedServerPath], {
      cwd: cwdDirectory,
      env: {
        ...process.env,
        CHENLONG_DATA_DIR: dataDirectory,
        HOST: "127.0.0.1",
        PORT: "0"
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true
    });
    child.stderr.on("data", chunk => {
      stderrState.value = `${stderrState.value}${chunk.toString("utf8")}`.slice(-4000);
    });
    t.after(async () => stopPackagedServer(child).catch(() => {}));
    const origin = await waitForListening(child, stderrState);

    const health = await request(origin, { path: "/api/health" });
    assert.equal(health.statusCode, 200, health.body.toString("utf8"));
    const healthPayload = JSON.parse(health.body.toString("utf8"));
    assert.equal(healthPayload.status, "ok");
    assert.equal(healthPayload.version, productionPackageShape().version);

    const anonymousRoot = await request(origin, { path: "/" });
    assert.equal(anonymousRoot.statusCode, 302);
    assert.match(anonymousRoot.headers.location || "", /^\/login\.html\?/);
    const login = await request(origin, { path: "/login.html" });
    assert.equal(login.statusCode, 200);
    const wasm = await request(origin, { method: "HEAD", path: "/vendor/pyodide/pyodide.asm.wasm" });
    assert.equal(wasm.statusCode, 200);
    const privateSource = await request(origin, { path: "/backend/guangyang-private-layout-catalog.js" });
    assert.equal(privateSource.statusCode, 404);
    const privateMapStore = await request(origin, { path: "/backend/guangyang-map-config-store.js" });
    assert.equal(privateMapStore.statusCode, 404);
    const privateMapPool = await request(origin, { path: "/backend/guangyang-map-pool.js" });
    assert.equal(privateMapPool.statusCode, 404);

    const malformed = Buffer.from("{not-json", "utf8");
    const verified = await request(origin, {
      method: "POST",
      path: "/api/v1/verify-run-record",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": malformed.length
      }
    }, malformed);
    assert.equal(verified.statusCode, 400, verified.body.toString("utf8"));
    assert.equal(JSON.parse(verified.body.toString("utf8")).error.code, "INVALID_JSON");

    await stopPackagedServer(child);
    assert.equal(fs.existsSync(path.join(dataDirectory, ".chenlong-writer.lock")), false);
  });
});
