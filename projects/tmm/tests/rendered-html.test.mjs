import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const forwardedOrigin = "https://studio.example.test";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

let validationServer;
let projectValidation;

async function getProjectValidation() {
  projectValidation ??= (async () => {
    const { createServer } = await import("vite");
    validationServer = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: projectRoot,
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    return validationServer.ssrLoadModule("/lib/project/validation.ts");
  })();

  return projectValidation;
}

after(async () => {
  await validationServer?.close();
});

async function renderHomePage() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: {
        accept: "text/html",
        "x-forwarded-host": "studio.example.test",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  return {
    html: await response.text(),
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
  };
}

let renderedPage;
function getRenderedPage() {
  renderedPage ??= renderHomePage();
  return renderedPage;
}

function parseAttributes(tag) {
  const attributes = new Map();
  const attributePattern = /\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  for (const match of tag.matchAll(attributePattern)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3]);
  }

  return attributes;
}

function findMeta(html, attributeName, attributeValue) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag);
    if (attributes.get(attributeName) === attributeValue) {
      return attributes;
    }
  }

  assert.fail(`missing meta[${attributeName}="${attributeValue}"]`);
}

function assertHtmlMatches(html, pattern, label) {
  assert.ok(pattern.test(html), `rendered HTML is missing ${label}`);
}

function assertHtmlOmits(html, pattern, label) {
  assert.ok(!pattern.test(html), `rendered HTML still contains ${label}`);
}

function makeValidProject() {
  const createdAt = "2026-08-24T08:00:00.000Z";
  return {
    format: "tm-object-project",
    formatVersion: 1,
    id: "project-demo",
    name: "桌面物品分类",
    createdAt,
    updatedAt: createdAt,
    training: { epochs: 20, batchSize: 16, learningRate: 0.001 },
    prediction: { confidenceThreshold: 0.65, marginThreshold: 0.12 },
    classes: [
      {
        id: "class-cup",
        name: "水杯",
        color: "#7357E8",
        samples: [
          {
            id: "sample-cup-1",
            name: "cup-1.jpg",
            dataUrl: "data:image/jpeg;base64,/9j/2Q==",
            source: "upload",
            createdAt,
            width: 224,
            height: 224,
            captureGroupId: "capture-demo-one",
          },
        ],
      },
      {
        id: "class-key",
        name: "钥匙",
        color: "#F09A57",
        samples: [],
      },
    ],
  };
}

test("server-renders the image-classification workbench instead of the starter", async () => {
  const { html, status, contentType } = await getRenderedPage();

  assert.equal(status, 200);
  assert.match(contentType, /^text\/html\b/i);
  assertHtmlMatches(html, /<html\b[^>]*\blang=["']zh-CN["']/i, "zh-CN language metadata");
  assertHtmlMatches(html, /<main\b/i, "the main workbench landmark");

  // These are the product's three core stages and primary project actions.
  assertHtmlMatches(html, /识物工坊/, "the product name");
  assertHtmlMatches(html, /训练模型识别橙子/, "the orange-classification headline");
  assertHtmlMatches(html, /橙子.*非橙子|非橙子.*橙子/, "the fixed competition labels");
  assertHtmlMatches(html, /准备(?:样本|数据)/, "the sample-preparation stage");
  assertHtmlMatches(html, /训练模型/, "the training stage");
  assertHtmlMatches(html, /测试与导出/, "the test-and-export stage");
  assertHtmlMatches(html, /添加图片/, "the image picker");
  assertHtmlMatches(html, /摄像头/, "the camera capture action");
  assertHtmlMatches(html, /开始训练/, "the training action");
  assertHtmlMatches(html, /导入项目/, "the project import action");
  assertHtmlMatches(html, /项目管理/, "multi-project management");
  assertHtmlMatches(html, /数据健康度/, "dataset health analysis");
  assertHtmlMatches(html, /(?:导出|备份)(?:训练)?项目/, "the project backup action");
  assertHtmlMatches(html, /下载训练模型/, "the trained-model download action");
  assertHtmlOmits(html, /添加一个类别/, "an add-class control in fixed competition mode");
  assertHtmlOmits(html, /删除类别/, "a delete-class control in fixed competition mode");

  assertHtmlOmits(
    html,
    /SkeletonPreview|sites-skeleton|react-loading-skeleton|Building your site|Your site is taking shape/i,
    "the starter loading skeleton",
  );
  assertHtmlOmits(html, /Starter Project/, "starter metadata");
  assertHtmlOmits(
    html,
    /<meta\b[^>]*\bname=["']codex-preview["']/i,
    "the development preview marker",
  );
});

test("publishes Chinese product and social metadata with the request origin", async () => {
  const { html } = await getRenderedPage();

  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? "";
  assert.match(title, /识物工坊/);
  assert.match(title, /橙子识别/);

  const description = findMeta(html, "name", "description").get("content") ?? "";
  assert.match(description, /橙子/);
  assert.match(description, /非橙子/);
  assert.match(description, /训练/);
  assert.match(description, /导入导出/);

  assert.equal(
    findMeta(html, "name", "application-name").get("content"),
    "识物工坊",
  );
  assert.equal(findMeta(html, "property", "og:locale").get("content"), "zh_CN");
  assert.equal(
    findMeta(html, "property", "og:image").get("content"),
    `${forwardedOrigin}/og.png`,
  );
  assert.equal(
    findMeta(html, "name", "twitter:card").get("content"),
    "summary_large_image",
  );
  assertHtmlMatches(
    html,
    /<link\b(?=[^>]*\brel=["']icon["'])(?=[^>]*\bhref=["']\/favicon\.svg["'])[^>]*>/i,
    "the product favicon",
  );
});

test("project validation accepts a valid portable project and rejects unsafe variants", async () => {
  const { estimateDataUrlBytes, validateProject } = await getProjectValidation();
  const project = makeValidProject();

  assert.doesNotThrow(() => validateProject(project));
  assert.equal(estimateDataUrlBytes("data:image/jpeg;base64,YQ=="), 1);
  assert.equal(
    estimateDataUrlBytes("data:image/png;base64,YQ=="),
    Number.POSITIVE_INFINITY,
  );

  const duplicateClass = structuredClone(project);
  duplicateClass.classes[1].id = duplicateClass.classes[0].id;
  assert.throws(() => validateProject(duplicateClass), {
    name: "ProjectValidationError",
    message: /project\.classes\[1\]\.id/,
  });

  const nonJpegSample = structuredClone(project);
  nonJpegSample.classes[0].samples[0].dataUrl = "data:image/png;base64,YQ==";
  assert.throws(() => validateProject(nonJpegSample), {
    name: "ProjectValidationError",
    message: /project\.classes\[0\]\.samples\[0\]\.dataUrl/,
  });
});

test("project backup export and import round-trip all classes and image samples", async () => {
  await getProjectValidation();
  const { exportProjectZip, importProjectZip } = await validationServer.ssrLoadModule(
    "/lib/project/project-archive.ts",
  );
  const project = makeValidProject();

  const archive = await exportProjectZip(project);
  assert.equal(archive.type, "application/zip");
  assert.ok(archive.size > 0, "project archive should contain data");

  const restored = await importProjectZip(await archive.arrayBuffer());
  assert.deepEqual(restored, project);
});

test("classifier metadata requires distinct labels and a supported image size", async () => {
  const { validateClassifierMetadata } = await getProjectValidation();
  const metadata = {
    format: "tm-object-classifier",
    formatVersion: 1,
    name: "桌面物品分类",
    createdAt: "2026-08-24T08:00:00.000Z",
    imageSize: 224,
    labels: [
      { id: "class-cup", name: "水杯", color: "#7357E8" },
      { id: "class-key", name: "钥匙", color: "#F09A57" },
    ],
    prediction: { confidenceThreshold: 0.65, marginThreshold: 0.12 },
  };

  assert.doesNotThrow(() => validateClassifierMetadata(metadata));

  const duplicateLabel = structuredClone(metadata);
  duplicateLabel.labels[1].id = duplicateLabel.labels[0].id;
  assert.throws(() => validateClassifierMetadata(duplicateLabel), {
    name: "ProjectValidationError",
    message: /metadata\.labels\[1\]\.id/,
  });

  const normalizedDuplicate = structuredClone(metadata);
  normalizedDuplicate.labels[0].name = "A";
  normalizedDuplicate.labels[1].name = "Ａ";
  assert.throws(() => validateClassifierMetadata(normalizedDuplicate), {
    name: "ProjectValidationError",
    message: /metadata\.labels\[1\]\.name/,
  });

  assert.throws(
    () => validateClassifierMetadata({ ...metadata, imageSize: 512 }),
    {
      name: "ProjectValidationError",
      message: /metadata\.imageSize/,
    },
  );

  assert.throws(
    () => validateClassifierMetadata({
      ...metadata,
      prediction: { confidenceThreshold: 1.2, marginThreshold: 0.12 },
    }),
    { name: "ProjectValidationError", message: /metadata\.prediction\.confidenceThreshold/ },
  );
});

test("project dataset signatures are stable but change with training data", async () => {
  await getProjectValidation();
  const {
    createProjectDatasetSignature,
    createProjectDatasetSignatureForVersion,
    PROJECT_DATASET_SIGNATURE_VERSION,
  } = await validationServer.ssrLoadModule("/lib/ml/model-storage.ts");
  const project = makeValidProject();
  project.classes[0].samples.push({
    ...project.classes[0].samples[0],
    id: "sample-cup-2",
    name: "cup-2.jpg",
    dataUrl: "data:image/jpeg;base64,/9j/2g==",
  });

  const signature = await createProjectDatasetSignature(project);
  const versionOneSignature = await createProjectDatasetSignatureForVersion(project, 1);
  const versionTwoSignature = await createProjectDatasetSignatureForVersion(project, 2);
  assert.match(
    signature,
    new RegExp(`^dataset-v${PROJECT_DATASET_SIGNATURE_VERSION}:sha256:[0-9a-f]{64}$`),
  );
  assert.match(versionOneSignature, /^dataset-v1:sha256:[0-9a-f]{64}$/);
  assert.match(versionTwoSignature, /^dataset-v2:sha256:[0-9a-f]{64}$/);
  assert.equal(
    versionOneSignature,
    "dataset-v1:sha256:4e09c70f68980c42c7a434a89c03ac6036a36cce42ad160b9c236e80815e7a45",
  );
  assert.equal(signature, versionTwoSignature);

  const presentationOnlyChange = structuredClone(project);
  presentationOnlyChange.name = "重命名后的项目";
  presentationOnlyChange.classes[0].color = "#123456";
  presentationOnlyChange.classes[0].samples[0].name = "新的显示名称.jpg";
  presentationOnlyChange.classes[0].samples.reverse();
  presentationOnlyChange.training.epochs = 80;
  presentationOnlyChange.prediction.confidenceThreshold = 0.8;
  assert.equal(
    await createProjectDatasetSignature(presentationOnlyChange),
    signature,
  );

  const changedPixels = structuredClone(project);
  changedPixels.classes[0].samples[0].dataUrl = "data:image/jpeg;base64,/9j/2w==";
  assert.notEqual(await createProjectDatasetSignature(changedPixels), signature);

  const changedLabel = structuredClone(project);
  changedLabel.classes[0].name = "马克杯";
  assert.notEqual(await createProjectDatasetSignature(changedLabel), signature);

  const changedCaptureGroup = structuredClone(project);
  changedCaptureGroup.classes[0].samples[0].captureGroupId = "capture-demo-two";
  assert.notEqual(await createProjectDatasetSignature(changedCaptureGroup), signature);
  assert.equal(
    await createProjectDatasetSignatureForVersion(changedCaptureGroup, 1),
    versionOneSignature,
  );
  assert.notEqual(
    await createProjectDatasetSignatureForVersion(changedCaptureGroup, 2),
    versionTwoSignature,
  );
});
