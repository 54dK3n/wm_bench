import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
let viteServer;
let dataHealthModule;

async function getDataHealth() {
  dataHealthModule ??= (async () => {
    const { createServer } = await import("vite");
    viteServer = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: projectRoot,
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    return viteServer.ssrLoadModule("/lib/project/data-health.ts");
  })();
  return dataHealthModule;
}

after(async () => {
  await viteServer?.close();
});

const createdAt = "2026-08-24T08:00:00.000Z";

function dataUrl(value) {
  return `data:image/jpeg;base64,${Buffer.from(value).toString("base64")}`;
}

function sample(id, content, options = {}) {
  return {
    id,
    name: `${id}.jpg`,
    dataUrl: dataUrl(content),
    source: options.source ?? "upload",
    createdAt: options.createdAt ?? createdAt,
    width: 224,
    height: 224,
  };
}

function projectClass(id, name, samples) {
  return { id, name, color: "#3157D5", samples };
}

function project(classes) {
  return {
    format: "tm-object-project",
    formatVersion: 1,
    id: "project-health-test",
    name: "数据健康测试",
    createdAt,
    updatedAt: createdAt,
    training: { epochs: 20, batchSize: 16, learningRate: 0.001 },
    classes,
  };
}

test("reports per-class quantity problems and global class imbalance", async () => {
  const { analyzeProjectDataHealth } = await getDataHealth();
  const result = await analyzeProjectDataHealth(project([
    projectClass("class-small", "少样本", [
      sample("small-1", "small-1"),
      sample("small-2", "small-2"),
    ]),
    projectClass("class-large", "多样本", Array.from(
      { length: 10 },
      (_, index) => sample(`large-${index}`, `large-${index}`),
    )),
  ]), {
    minimumSamplesPerClass: 3,
    recommendedSamplesPerClass: 5,
    imbalanceRatio: 2,
  });

  assert.equal(result.totalSamples, 12);
  assert.deepEqual(
    result.classes[0].issues.map((issue) => issue.code),
    ["insufficient-samples"],
  );
  assert.equal(result.classes[0].issues[0].severity, "error");
  assert.deepEqual(result.classes[0].issues[0].sampleIds, []);
  assert.equal(result.globalIssues[0].code, "class-imbalance");
  assert.deepEqual(result.globalIssues[0].classIds, ["class-small", "class-large"]);
});

test("finds verified exact duplicates within and across classes", async () => {
  const { analyzeProjectDataHealth } = await getDataHealth();
  const repeated = "identical-image-bytes";
  const result = await analyzeProjectDataHealth(project([
    projectClass("class-a", "甲", [
      sample("a-1", repeated),
      sample("a-2", repeated),
      sample("a-3", "different-a"),
    ]),
    projectClass("class-b", "乙", [sample("b-1", repeated)]),
  ]), {
    minimumSamplesPerClass: 1,
    recommendedSamplesPerClass: 1,
    imbalanceRatio: 10,
  });

  const classDuplicate = result.classes[0].issues.find(
    (issue) => issue.code === "exact-duplicate",
  );
  assert.deepEqual(classDuplicate?.sampleIds, ["a-1", "a-2"]);
  const crossClassDuplicate = result.globalIssues.find(
    (issue) => issue.code === "cross-class-exact-duplicate",
  );
  assert.equal(crossClassDuplicate?.severity, "error");
  assert.deepEqual(crossClassDuplicate?.classIds, ["class-a", "class-b"]);
  assert.deepEqual(crossClassDuplicate?.sampleIds, ["a-1", "a-2", "b-1"]);
});

test("groups near-identical consecutive camera frames with an injected hash provider", async () => {
  const { analyzeClassDataHealth } = await getDataHealth();
  const at = (milliseconds) => new Date(Date.parse(createdAt) + milliseconds).toISOString();
  const input = projectClass("class-camera", "摄像头类别", [
    sample("camera-1", "frame-1", { source: "camera", createdAt: at(0) }),
    sample("camera-2", "frame-2", { source: "camera", createdAt: at(650) }),
    sample("camera-3", "frame-3", { source: "camera", createdAt: at(1_300) }),
    sample("camera-4", "frame-4", { source: "camera", createdAt: at(8_000) }),
  ]);
  const hashes = new Map([
    ["camera-1", new Uint8Array([0, 0])],
    ["camera-2", new Uint8Array([1, 0])],
    ["camera-3", new Uint8Array([255, 255])],
    ["camera-4", new Uint8Array([255, 255])],
  ]);
  const result = await analyzeClassDataHealth(input, {
    minimumSamplesPerClass: 1,
    recommendedSamplesPerClass: 1,
    nearDuplicateHammingDistance: 1,
    consecutiveCaptureWindowMs: 2_000,
    perceptualHashProvider: (entry) => hashes.get(entry.id) ?? null,
  });

  assert.equal(result.nearDuplicateAnalysis, "complete");
  const issue = result.issues.find(
    (candidate) => candidate.code === "consecutive-camera-near-duplicate",
  );
  assert.deepEqual(issue?.sampleIds, ["camera-1", "camera-2"]);
});

test("degrades cleanly when browser image APIs are unavailable", async () => {
  const { analyzeClassDataHealth } = await getDataHealth();
  const input = projectClass("class-camera", "摄像头类别", [
    sample("camera-1", "frame-1", { source: "camera" }),
    sample("camera-2", "frame-2", {
      source: "camera",
      createdAt: new Date(Date.parse(createdAt) + 650).toISOString(),
    }),
  ]);
  const result = await analyzeClassDataHealth(input, {
    minimumSamplesPerClass: 1,
    recommendedSamplesPerClass: 1,
  });

  assert.equal(result.nearDuplicateAnalysis, "unavailable");
  assert.ok(!result.issues.some(
    (issue) => issue.code === "consecutive-camera-near-duplicate",
  ));
});

test("honors cancellation during asynchronous perceptual analysis", async () => {
  const { analyzeClassDataHealth } = await getDataHealth();
  const controller = new AbortController();
  const input = projectClass("class-camera", "摄像头类别", [
    sample("camera-1", "frame-1", { source: "camera" }),
    sample("camera-2", "frame-2", {
      source: "camera",
      createdAt: new Date(Date.parse(createdAt) + 650).toISOString(),
    }),
  ]);

  await assert.rejects(
    analyzeClassDataHealth(input, {
      signal: controller.signal,
      minimumSamplesPerClass: 1,
      recommendedSamplesPerClass: 1,
      perceptualHashProvider: () => {
        controller.abort();
        return new Uint8Array([0]);
      },
    }),
    (error) => error?.name === "AbortError",
  );
});
