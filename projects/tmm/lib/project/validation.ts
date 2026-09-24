import {
  MODEL_PACKAGE_FORMAT,
  MODEL_PACKAGE_VERSION,
  PROJECT_FORMAT,
  PROJECT_FORMAT_VERSION,
  SUPPORTED_IMAGE_SIZES,
  type ClassifierModelMetadata,
  type Project,
  type ProjectClass,
  type ProjectSample,
  type ProjectSampleSource,
  type PredictionSettings,
  type SupportedImageSize,
  type TrainingSettings,
} from "./types";

export const PROJECT_LIMITS = {
  maxProjectNameLength: 120,
  maxClassCount: 50,
  maxClassNameLength: 80,
  maxSamplesPerClass: 2_000,
  maxTotalSamples: 5_000,
  maxSampleNameLength: 180,
  maxSampleBytes: 2 * 1024 * 1024,
  maxProjectBytes: 200 * 1024 * 1024,
} as const;

export const MODEL_LIMITS = {
  maxArchiveBytes: 220 * 1024 * 1024,
  maxModelJsonBytes: 10 * 1024 * 1024,
  maxWeightsBytes: 200 * 1024 * 1024,
  maxMetadataBytes: 1024 * 1024,
  maxLabels: 100,
} as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/;
const JPEG_DATA_URL_PATTERN = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectValidationError";
  }
}

function fail(path: string, reason: string): never {
  throw new ProjectValidationError(`${path}: ${reason}`);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(path, "必须是对象");
  }
}

function assertString(
  value: unknown,
  path: string,
  minLength: number,
  maxLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length < minLength ||
    value.length > maxLength
  ) {
    fail(path, `必须是长度 ${minLength}–${maxLength} 的字符串`);
  }
}

function assertId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail(path, "不是有效标识符");
  }
}

function assertIsoDate(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !ISO_DATE_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(path, "不是有效 ISO 日期");
  }
}

export function isSupportedImageSize(value: unknown): value is SupportedImageSize {
  return SUPPORTED_IMAGE_SIZES.some((size) => size === value);
}

export function validateTrainingSettings(
  value: unknown,
  path = "training",
): asserts value is TrainingSettings {
  assertObject(value, path);
  if (!Number.isInteger(value.epochs) || (value.epochs as number) < 1 || (value.epochs as number) > 500) {
    fail(`${path}.epochs`, "必须是 1–500 的整数");
  }
  if (
    !Number.isInteger(value.batchSize) ||
    (value.batchSize as number) < 1 ||
    (value.batchSize as number) > 512
  ) {
    fail(`${path}.batchSize`, "必须是 1–512 的整数");
  }
  if (
    typeof value.learningRate !== "number" ||
    !Number.isFinite(value.learningRate) ||
    value.learningRate <= 0 ||
    value.learningRate > 1
  ) {
    fail(`${path}.learningRate`, "必须是大于 0 且不超过 1 的数值");
  }
}

export function validatePredictionSettings(
  value: unknown,
  path = "prediction",
): asserts value is PredictionSettings {
  assertObject(value, path);
  if (
    typeof value.confidenceThreshold !== "number" ||
    !Number.isFinite(value.confidenceThreshold) ||
    value.confidenceThreshold < 0 ||
    value.confidenceThreshold > 1
  ) {
    fail(`${path}.confidenceThreshold`, "必须是 0–1 之间的数值");
  }
  if (
    typeof value.marginThreshold !== "number" ||
    !Number.isFinite(value.marginThreshold) ||
    value.marginThreshold < 0 ||
    value.marginThreshold > 1
  ) {
    fail(`${path}.marginThreshold`, "必须是 0–1 之间的数值");
  }
}

export function estimateDataUrlBytes(dataUrl: string): number {
  const match = JPEG_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    return Number.POSITIVE_INFINITY;
  }

  const base64 = match[1];
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function validateJpegDataUrl(
  value: unknown,
  path: string,
  maxBytes = PROJECT_LIMITS.maxSampleBytes,
): asserts value is string {
  if (typeof value !== "string") {
    fail(path, "必须是 base64 编码的 JPEG data URL");
  }
  const match = JPEG_DATA_URL_PATTERN.exec(value);
  if (!match || match[1].length % 4 !== 0) {
    fail(path, "必须是 base64 编码的 JPEG data URL");
  }
  if (estimateDataUrlBytes(value) > maxBytes) {
    fail(path, `图片不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
}

function validateSample(value: unknown, path: string): asserts value is ProjectSample {
  assertObject(value, path);
  assertId(value.id, `${path}.id`);
  assertString(value.name, `${path}.name`, 1, PROJECT_LIMITS.maxSampleNameLength);
  validateJpegDataUrl(value.dataUrl, `${path}.dataUrl`);
  if (!["upload", "camera", "import"].includes(value.source as ProjectSampleSource)) {
    fail(`${path}.source`, "来源无效");
  }
  assertIsoDate(value.createdAt, `${path}.createdAt`);
  if (!isSupportedImageSize(value.width) || value.height !== value.width) {
    fail(path, "样本必须是 224×224 或 256×256 的正方形图片");
  }
  if (value.captureGroupId !== undefined) {
    assertId(value.captureGroupId, `${path}.captureGroupId`);
  }
}

function validateProjectClass(value: unknown, path: string): asserts value is ProjectClass {
  assertObject(value, path);
  assertId(value.id, `${path}.id`);
  assertString(value.name, `${path}.name`, 0, PROJECT_LIMITS.maxClassNameLength);
  if (typeof value.color !== "string" || !HEX_COLOR.test(value.color)) {
    fail(`${path}.color`, "必须是 #RRGGBB 颜色");
  }
  if (!Array.isArray(value.samples) || value.samples.length > PROJECT_LIMITS.maxSamplesPerClass) {
    fail(`${path}.samples`, `样本数不能超过 ${PROJECT_LIMITS.maxSamplesPerClass}`);
  }

  const sampleIds = new Set<string>();
  value.samples.forEach((sample, index) => {
    validateSample(sample, `${path}.samples[${index}]`);
    if (sampleIds.has(sample.id)) {
      fail(`${path}.samples[${index}].id`, "样本标识符重复");
    }
    sampleIds.add(sample.id);
  });
}

export function validateProject(value: unknown): asserts value is Project {
  assertObject(value, "project");
  if (value.format !== PROJECT_FORMAT || value.formatVersion !== PROJECT_FORMAT_VERSION) {
    fail("project", "项目格式或版本不受支持");
  }
  assertId(value.id, "project.id");
  assertString(value.name, "project.name", 0, PROJECT_LIMITS.maxProjectNameLength);
  assertIsoDate(value.createdAt, "project.createdAt");
  assertIsoDate(value.updatedAt, "project.updatedAt");
  validateTrainingSettings(value.training);
  if (value.prediction !== undefined) {
    validatePredictionSettings(value.prediction);
  }
  if (!Array.isArray(value.classes) || value.classes.length > PROJECT_LIMITS.maxClassCount) {
    fail("project.classes", `类别数不能超过 ${PROJECT_LIMITS.maxClassCount}`);
  }

  let totalSamples = 0;
  let totalImageBytes = 0;
  const classIds = new Set<string>();
  value.classes.forEach((projectClass, index) => {
    validateProjectClass(projectClass, `project.classes[${index}]`);
    if (classIds.has(projectClass.id)) {
      fail(`project.classes[${index}].id`, "类别标识符重复");
    }
    classIds.add(projectClass.id);
    totalSamples += projectClass.samples.length;
    totalImageBytes += projectClass.samples.reduce(
      (sum, sample) => sum + estimateDataUrlBytes(sample.dataUrl),
      0,
    );
  });

  if (totalSamples > PROJECT_LIMITS.maxTotalSamples) {
    fail("project.classes", `项目样本总数不能超过 ${PROJECT_LIMITS.maxTotalSamples}`);
  }
  if (totalImageBytes > PROJECT_LIMITS.maxProjectBytes) {
    fail("project.classes", "项目图片总大小超过限制");
  }
}

export function validateClassifierMetadata(
  value: unknown,
): asserts value is ClassifierModelMetadata {
  assertObject(value, "metadata");
  if (value.format !== MODEL_PACKAGE_FORMAT || value.formatVersion !== MODEL_PACKAGE_VERSION) {
    fail("metadata", "模型元数据格式或版本不受支持");
  }
  assertString(value.name, "metadata.name", 1, PROJECT_LIMITS.maxProjectNameLength);
  assertIsoDate(value.createdAt, "metadata.createdAt");
  if (!isSupportedImageSize(value.imageSize)) {
    fail("metadata.imageSize", "仅支持 224 或 256");
  }
  if (
    !Array.isArray(value.labels) ||
    value.labels.length < 2 ||
    value.labels.length > MODEL_LIMITS.maxLabels
  ) {
    fail("metadata.labels", `标签数量必须为 2–${MODEL_LIMITS.maxLabels}`);
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  value.labels.forEach((label, index) => {
    assertObject(label, `metadata.labels[${index}]`);
    assertId(label.id, `metadata.labels[${index}].id`);
    assertString(label.name, `metadata.labels[${index}].name`, 1, PROJECT_LIMITS.maxClassNameLength);
    if (typeof label.color !== "string" || !HEX_COLOR.test(label.color)) {
      fail(`metadata.labels[${index}].color`, "必须是 #RRGGBB 颜色");
    }
    if (ids.has(label.id)) {
      fail(`metadata.labels[${index}].id`, "标签标识符重复");
    }
    ids.add(label.id);
    const normalizedName = label.name.normalize("NFKC").trim();
    if (names.has(normalizedName)) {
      fail(`metadata.labels[${index}].name`, "标签名称重复");
    }
    names.add(normalizedName);
  });

  if (value.training !== undefined) {
    validateTrainingSettings(value.training, "metadata.training");
  }
  if (value.featureExtractor !== undefined) {
    assertString(value.featureExtractor, "metadata.featureExtractor", 1, 120);
  }
  if (value.prediction !== undefined) {
    validatePredictionSettings(value.prediction, "metadata.prediction");
  }
}
