import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

let runtimeServer;
let runtimeModule;

async function getRuntime() {
  runtimeModule ??= (async () => {
    const { createServer } = await import("vite");
    runtimeServer = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: projectRoot,
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    return runtimeServer.ssrLoadModule("/lib/ml/runtime.ts");
  })();
  return runtimeModule;
}

after(async () => {
  await runtimeServer?.close();
});

function example(label, groupId) {
  return groupId === undefined
    ? { image: null, label }
    : { image: null, label, groupId };
}

function assertApprox(actual, expected, epsilon = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test("group-stratified validation is deterministic and never divides a class group", async () => {
  const { stratifiedGroupDatasetSplit } = await getRuntime();
  const examples = [
    example("A", "a-burst"),
    example("A", "a-burst"),
    example("A", "a-single-1"),
    example("A", "a-single-2"),
    example("B", "b-burst"),
    example("B", "b-burst"),
    example("B", "b-single-1"),
    example("B", "b-single-2"),
  ];
  const classIndexes = [0, 0, 0, 0, 1, 1, 1, 1];
  const first = stratifiedGroupDatasetSplit(examples, classIndexes, 2, 0.25);
  const second = stratifiedGroupDatasetSplit(examples, classIndexes, 2, 0.25);

  assert.deepEqual(first, second);
  assert.equal(first.validationStatus, "available");
  assert.deepEqual(
    [...first.trainingIndexes, ...first.validationIndexes].sort((left, right) => left - right),
    classIndexes.map((_, index) => index),
  );

  const training = new Set(first.trainingIndexes);
  const validation = new Set(first.validationIndexes);
  for (const indexes of [[0, 1], [2], [3], [4, 5], [6], [7]]) {
    assert.ok(
      indexes.every((index) => training.has(index)) ||
        indexes.every((index) => validation.has(index)),
    );
  }
  for (const classIndex of [0, 1]) {
    const indexes = classIndexes
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => value === classIndex)
      .map(({ index }) => index);
    assert.ok(indexes.some((index) => training.has(index)));
    assert.ok(indexes.some((index) => validation.has(index)));
  }
});

test("missing group ids make ordinary uploads independent validation groups", async () => {
  const { stratifiedGroupDatasetSplit } = await getRuntime();
  const examples = [
    example("A"),
    example("A"),
    example("A"),
    example("B"),
    example("B"),
    example("B"),
  ];
  const split = stratifiedGroupDatasetSplit(examples, [0, 0, 0, 1, 1, 1], 2, 0.34);

  assert.equal(split.validationStatus, "available");
  assert.equal(split.trainingIndexes.length, 2);
  assert.equal(split.validationIndexes.length, 4);
});

test("validation safely falls back when any class has fewer than two groups", async () => {
  const { stratifiedGroupDatasetSplit } = await getRuntime();
  const examples = [
    example("A", "only-a-group"),
    example("A", "only-a-group"),
    example("B", "b-group-1"),
    example("B", "b-group-2"),
  ];
  const split = stratifiedGroupDatasetSplit(examples, [0, 0, 1, 1], 2, 0.25);

  assert.equal(split.validationStatus, "insufficient-groups");
  assert.deepEqual(split.trainingIndexes, [0, 1, 2, 3]);
  assert.deepEqual(split.validationIndexes, []);
});

test("validation metrics return the expected confusion matrix and macro scores", async () => {
  const { computeValidationMetrics } = await getRuntime();
  const metrics = computeValidationMetrics(
    ["A", "B", "C"],
    [0, 0, 1, 1, 1, 2],
    [0, 1, 1, 1, 2, 2],
  );

  assert.equal(metrics.exampleCount, 6);
  assert.deepEqual(metrics.support, [2, 3, 1]);
  assert.deepEqual(metrics.confusionMatrix, [
    [1, 1, 0],
    [0, 2, 1],
    [0, 0, 1],
  ]);
  assert.deepEqual(metrics.perClass.map(({ label, support }) => ({ label, support })), [
    { label: "A", support: 2 },
    { label: "B", support: 3 },
    { label: "C", support: 1 },
  ]);
  assertApprox(metrics.perClass[0].precision, 1);
  assertApprox(metrics.perClass[0].recall, 1 / 2);
  assertApprox(metrics.perClass[0].f1, 2 / 3);
  assertApprox(metrics.perClass[1].precision, 2 / 3);
  assertApprox(metrics.perClass[1].recall, 2 / 3);
  assertApprox(metrics.perClass[1].f1, 2 / 3);
  assertApprox(metrics.perClass[2].precision, 1 / 2);
  assertApprox(metrics.perClass[2].recall, 1);
  assertApprox(metrics.perClass[2].f1, 2 / 3);
  assertApprox(metrics.accuracy, 2 / 3);
  assertApprox(metrics.macroF1, 2 / 3);
  assertApprox(metrics.balancedAccuracy, 13 / 18);
});

test("validation metrics reject empty, mismatched, or invalid class indexes", async () => {
  const { computeValidationMetrics } = await getRuntime();
  assert.throws(() => computeValidationMetrics(["A", "B"], [], []), /at least one/i);
  assert.throws(
    () => computeValidationMetrics(["A", "B"], [0], [0, 1]),
    /same length/i,
  );
  assert.throws(
    () => computeValidationMetrics(["A", "B"], [0, 2], [0, 1]),
    /invalid validation class index/i,
  );
});
