import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const validationServer = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "silent",
  root: projectRoot,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

after(async () => validationServer.close());

const capacityModule = await validationServer.ssrLoadModule("/lib/competition/capacity.ts");
const cacheModule = await validationServer.ssrLoadModule("/lib/competition/evaluation-cache.ts");

test("the bounded FIFO executes 500 jobs without exceeding its concurrency", async () => {
  const queue = new capacityModule.CompetitionWorkQueue(4, 2_000);
  let active = 0;
  let peakActive = 0;
  const started = [];
  const admissions = Array.from({ length: 500 }, (_, index) => queue.enqueue(
    `job-${index}`,
    async () => {
      started.push(index);
      active += 1;
      peakActive = Math.max(peakActive, active);
      await Promise.resolve();
      active -= 1;
      return index;
    },
  ));
  assert.equal(admissions.every(({ accepted }) => accepted), true);
  const results = await Promise.all(admissions.map(({ promise }) => promise));
  assert.deepEqual(results, Array.from({ length: 500 }, (_, index) => index));
  assert.deepEqual(started, Array.from({ length: 500 }, (_, index) => index));
  assert.equal(peakActive, 4);
  assert.deepEqual(queue.snapshot(), {
    concurrency: 4,
    capacity: 2_000,
    active: 0,
    pending: 0,
    uniqueJobs: 0,
    accepted: 500,
    completed: 500,
    failed: 0,
    rejected: 0,
  });
});

test("the queue deduplicates retries and reports saturation instead of dropping work", async () => {
  const queue = new capacityModule.CompetitionWorkQueue(1, 2);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let executions = 0;
  const first = queue.enqueue("same", async () => {
    executions += 1;
    await gate;
    return 7;
  });
  const duplicate = queue.enqueue("same", async () => 99);
  const second = queue.enqueue("second", async () => 8);
  const rejected = queue.enqueue("third", async () => 9);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.promise, first.promise);
  assert.equal(second.accepted, true);
  assert.equal(rejected.accepted, false);
  release();
  assert.deepEqual(await Promise.all([first.promise, duplicate.promise, second.promise]), [7, 7, 8]);
  assert.equal(executions, 1);
  assert.equal(queue.snapshot().rejected, 1);
});

test("500 simultaneous evaluation readers share one validated storage read", async () => {
  const evaluation = {
    format: "tm-competition-evaluation",
    version: 1,
    division: "primary",
    createdAt: "2026-08-28T00:00:00.000Z",
    featureExtractor: "mobilenet-v2-alpha-0.5-embedding",
    preprocessing: "center-crop-224-rgb-v1",
    embeddingSize: 1280,
    labels: ["橙子", "非橙子"],
    sampleLabelIndexes: [0, 1],
    embeddingsBase64: Buffer.alloc(2 * 1280 * 4).toString("base64"),
  };
  let reads = 0;
  const storage = {
    async get(key) {
      assert.equal(key, "evaluation-v1.json");
      reads += 1;
      await Promise.resolve();
      return {
        async text() { return JSON.stringify(evaluation); },
        async arrayBuffer() { throw new Error("not used"); },
      };
    },
    async put() {},
    async delete() {},
  };
  const reference = { division: "primary", version: "1", objectKey: "evaluation-v1.json" };
  const values = await Promise.all(Array.from(
    { length: 500 },
    () => cacheModule.loadCompetitionEvaluationSet(storage, reference),
  ));
  assert.equal(reads, 1);
  assert.equal(values.every((value) => value === values[0]), true);
  assert.equal(cacheModule.competitionEvaluationCacheSnapshot().hits >= 499, true);
});

test("competition capacity is explicitly sized for 2,000 accounts and 500 active users", () => {
  assert.equal(capacityModule.MAX_COMPETITION_USERS, 2_000);
  assert.equal(capacityModule.COMPETITION_SCORING_QUEUE_CAPACITY >= 2_000, true);
  assert.equal(capacityModule.COMPETITION_TEAM_WRITE_QUEUE_CAPACITY >= 2_000, true);
});
