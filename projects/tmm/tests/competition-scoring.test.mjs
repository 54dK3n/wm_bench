import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
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

const evaluationModule = await validationServer.ssrLoadModule(
  "/lib/competition/evaluation-format.ts",
);
const scoringModule = await validationServer.ssrLoadModule(
  "/lib/competition/scoring.ts",
);
const submissionsModule = await validationServer.ssrLoadModule(
  "/lib/competition/submissions.ts",
);
const evaluationBuilderModule = await validationServer.ssrLoadModule(
  "/lib/competition/evaluation-builder.ts",
);
const projectMigrationModule = await validationServer.ssrLoadModule(
  "/lib/competition/project-migration.ts",
);

function encodeFloat32(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

async function makeClassifierArchive(labels = ["橙子", "非橙子"]) {
  const hiddenUnits = 100;
  const embeddingSize = 1280;
  const classCount = labels.length;
  const kernelOne = new Float32Array(embeddingSize * hiddenUnits);
  const biasOne = new Float32Array(hiddenUnits);
  const kernelTwo = new Float32Array(hiddenUnits * classCount);
  const biasTwo = new Float32Array(classCount);
  biasOne[0] = 1;
  kernelTwo[0] = 1;
  kernelTwo[1] = -1;
  const weights = encodeFloat32([
    ...kernelOne,
    ...biasOne,
    ...kernelTwo,
    ...biasTwo,
  ]);
  const modelJson = {
    modelTopology: { class_name: "Sequential", config: { layers: [] } },
    weightsManifest: [{
      paths: ["weights.bin"],
      weights: [
        { name: "dense/kernel", shape: [embeddingSize, hiddenUnits], dtype: "float32" },
        { name: "dense/bias", shape: [hiddenUnits], dtype: "float32" },
        { name: "dense_1/kernel", shape: [hiddenUnits, classCount], dtype: "float32" },
        { name: "dense_1/bias", shape: [classCount], dtype: "float32" },
      ],
    }],
  };
  const metadata = {
    format: "tm-object-classifier",
    formatVersion: 1,
    name: "比赛测试模型",
    createdAt: "2026-08-26T00:00:00.000Z",
    imageSize: 224,
    labels: labels.map((name, index) => ({
      id: `model-label-${index + 1}`,
      name,
      color: index === 0 ? "#3157D5" : "#F47A5A",
    })),
    featureExtractor: "MobileNet v2 alpha 0.5 embedding",
    prediction: { confidenceThreshold: 0.65, marginThreshold: 0.12 },
  };
  const zip = new JSZip();
  zip.file("model.json", JSON.stringify(modelJson));
  zip.file("weights.bin", weights, { binary: true, compression: "STORE" });
  zip.file("metadata.json", JSON.stringify(metadata));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function makeEvaluationSet(labels = ["橙子", "非橙子"], sampleLabelIndexes = labels.map((_, index) => index)) {
  const values = new Float32Array(sampleLabelIndexes.length * 1280);
  return evaluationModule.validateCompetitionEvaluationSet({
    format: "tm-competition-evaluation",
    version: 1,
    division: "primary",
    createdAt: "2026-08-26T00:00:00.000Z",
    featureExtractor: "mobilenet-v2-alpha-0.5-embedding",
    preprocessing: "center-crop-224-rgb-v1",
    embeddingSize: 1280,
    labels,
    sampleLabelIndexes,
    embeddingsBase64: evaluationModule.encodeEvaluationEmbeddings(values),
  });
}

test("competition evaluator scores the fixed classifier head without executing topology", async () => {
  const archive = await makeClassifierArchive();
  const score = await scoringModule.scoreCompetitionModel(archive, makeEvaluationSet());

  assert.equal(score.modelName, "比赛测试模型");
  assert.equal(score.totalCount, 2);
  assert.equal(score.correctCount, 1);
  assert.equal(score.scoreMicros, 500_000);
  assert.equal(score.rankingMetric, "balancedAccuracy");
  assert.equal(score.accuracy, 0.5);
  assert.deepEqual(score.confusionMatrix, [[1, 0], [1, 0]]);
  assert.match(score.artifactSha256, /^[0-9a-f]{64}$/);
});

test("competition evaluator rejects a model outside the fixed orange categories", async () => {
  const archive = await makeClassifierArchive(["橙子", "苹果"]);
  await assert.rejects(
    scoringModule.scoreCompetitionModel(archive, makeEvaluationSet()),
    /比赛模型类别必须且只能包含“橙子”和“非橙子”两个类别/,
  );
});

test("competition ranking uses balanced accuracy when class counts differ", async () => {
  const archive = await makeClassifierArchive();
  const score = await scoringModule.scoreCompetitionModel(
    archive,
    makeEvaluationSet(["橙子", "非橙子"], [0, 0, 0, 1]),
  );

  assert.equal(score.correctCount, 3);
  assert.equal(score.totalCount, 4);
  assert.equal(score.accuracy, 0.75);
  assert.equal(score.balancedAccuracy, 0.5);
  assert.equal(score.scoreMicros, 500_000);
});

test("competition scoring accepts the two fixed labels in reverse order", async () => {
  const archive = await makeClassifierArchive();
  const score = await scoringModule.scoreCompetitionModel(
    archive,
    makeEvaluationSet(["非橙子", "橙子"], [0, 1]),
  );

  assert.deepEqual(score.labels, ["橙子", "非橙子"]);
  assert.equal(score.totalCount, 2);
  assert.equal(score.scoreMicros, 500_000);
});

test("evaluation set requires exactly orange and non-orange labels", () => {
  assert.throws(
    () => makeEvaluationSet(["物品 A", "物品 B"]),
    /测试集类别必须且只能包含“橙子”和“非橙子”两个类别/,
  );
});

test("legacy placeholder projects migrate directly to orange and non-orange", () => {
  const legacy = {
    format: "tm-object-project",
    formatVersion: 1,
    id: "legacy-project",
    name: "未命名项目",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    training: { epochs: 20, batchSize: 16, learningRate: 0.001 },
    classes: [
      { id: "class-a", name: "物品 A", color: "#3157D5", samples: [{ id: "sample-a" }] },
      { id: "class-b", name: "物品 B", color: "#F47A5A", samples: [{ id: "sample-b" }] },
    ],
  };
  const migrated = projectMigrationModule.migrateLegacyOrangeCompetitionProject(
    legacy,
    Date.parse("2026-08-27T00:00:00.000Z"),
  );

  assert.ok(migrated);
  assert.equal(migrated.name, "橙子识别项目");
  assert.deepEqual(migrated.classes.map(({ name }) => name), ["橙子", "非橙子"]);
  assert.deepEqual(migrated.classes.map(({ samples }) => samples), legacy.classes.map(({ samples }) => samples));
  assert.equal(migrated.updatedAt, "2026-08-27T00:00:00.000Z");
  assert.deepEqual(legacy.classes.map(({ name }) => name), ["物品 A", "物品 B"]);
});

test("evaluation feature payload validates its exact byte length", () => {
  const evaluation = makeEvaluationSet();
  const corrupted = { ...evaluation, embeddingsBase64: evaluation.embeddingsBase64.slice(0, -4) };
  assert.throws(
    () => evaluationModule.validateCompetitionEvaluationSet(corrupted),
    /特征长度错误/,
  );
});

test("participant submission summaries do not expose hidden-set scores", () => {
  const summary = submissionsModule.participantSubmissionSummaryFromRow({
    id: "submission-1",
    team_id: "team-1",
    status: "scored",
    model_name: "model.zip",
    submitted_at: 1,
    scored_at: 2,
    score_micros: 875_000,
    correct_count: 7,
    total_count: 8,
    error_message: null,
    evaluation_version: "1",
  });
  assert.deepEqual(summary, {
    id: "submission-1",
    status: "submitted",
    submittedAt: 1,
  });
  for (const privateField of [
    "modelName",
    "scoredAt",
    "scoreMicros",
    "correctCount",
    "totalCount",
    "errorMessage",
    "evaluationVersion",
  ]) {
    assert.equal(privateField in summary, false, `${privateField} must not be exposed`);
  }
});

test("evaluation archive maps project backup image paths back to class names", async () => {
  const zip = new JSZip();
  const project = {
    format: "tm-object-project-archive",
    formatVersion: 1,
    exportedAt: "2026-08-27T00:00:00.000Z",
    project: {
      classes: [
        {
          id: "class-a",
          name: "橙子",
          samples: [{ imagePath: "images/01-class-a/0001-a.jpg" }],
        },
        {
          id: "class-b",
          name: "非橙子",
          samples: [{ imagePath: "images/02-class-b/0001-b.jpg" }],
        },
      ],
    },
  };
  zip.file("project.json", JSON.stringify(project));
  zip.file("images/01-class-a/0001-a.jpg", new Uint8Array([1]));
  zip.file("images/02-class-b/0001-b.jpg", new Uint8Array([2]));
  const inspected = await evaluationBuilderModule.inspectCompetitionEvaluationArchive(
    await zip.generateAsync({ type: "uint8array" }),
  );

  assert.deepEqual(inspected.labels, ["橙子", "非橙子"]);
  assert.deepEqual(inspected.entries.map(({ label }) => label), ["橙子", "非橙子"]);
});

test("evaluation archive accepts more than one shared wrapper folder", async () => {
  const zip = new JSZip();
  zip.file("测试/images/橙子/a.jpg", new Uint8Array([1]));
  zip.file("测试/images/非橙子/b.jpg", new Uint8Array([2]));
  const inspected = await evaluationBuilderModule.inspectCompetitionEvaluationArchive(
    await zip.generateAsync({ type: "uint8array" }),
  );

  assert.deepEqual(inspected.labels, ["橙子", "非橙子"]);
});
