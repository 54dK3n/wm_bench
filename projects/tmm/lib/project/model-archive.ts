import * as tf from "@tensorflow/tfjs";
import JSZip from "jszip";

import { validateClassifierModelBundle } from "../ml/model-bundle";
import type { ClassifierModelBundle } from "../ml/types";
import { concatenateArrayBuffers, copyArrayBuffer, utf8ByteLength } from "./binary";
import { sanitizeFilename } from "./download";
import type { ClassifierModelMetadata } from "./types";
import {
  isPlainObject,
  MODEL_LIMITS,
  validateClassifierMetadata,
} from "./validation";

export const CLASSIFIER_MODEL_MIME_TYPE = "application/zip";
export const CLASSIFIER_MODEL_FILES = {
  model: "model.json",
  weights: "weights.bin",
  metadata: "metadata.json",
} as const;

export type ClassifierModelSource = tf.LayersModel | tf.io.ModelArtifacts;

export interface ImportedClassifierModel {
  model: tf.LayersModel;
  artifacts: tf.io.ModelArtifacts;
  metadata: ClassifierModelMetadata;
}

export class ModelArchiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelArchiveError";
  }
}

function inputByteLength(input: Blob | ArrayBuffer | Uint8Array): number {
  if ("size" in input) {
    return input.size;
  }
  return input.byteLength;
}

function declaredUncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  const internal = entry as JSZip.JSZipObject & {
    _data?: { uncompressedSize?: unknown };
  };
  const size = internal._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : undefined;
}

function isLayersModel(value: ClassifierModelSource): value is tf.LayersModel {
  return typeof (value as Partial<tf.LayersModel>).save === "function";
}

async function captureModelArtifacts(model: tf.LayersModel): Promise<tf.io.ModelArtifacts> {
  let captured: tf.io.ModelArtifacts | undefined;
  await model.save(
    tf.io.withSaveHandler(async (artifacts) => {
      captured = artifacts;
      return {
        modelArtifactsInfo: tf.io.getModelArtifactsInfoForJSON(artifacts),
      };
    }),
    { includeOptimizer: false },
  );
  if (!captured) {
    throw new ModelArchiveError("TensorFlow.js 未返回模型数据");
  }
  return captured;
}

function normalizeWeightData(weightData: tf.io.WeightData | undefined): ArrayBuffer {
  if (weightData instanceof ArrayBuffer) {
    return weightData.slice(0);
  }
  if (Array.isArray(weightData)) {
    return concatenateArrayBuffers(weightData);
  }
  throw new ModelArchiveError("模型缺少权重数据");
}

function assertWeightSpec(value: unknown, path: string): asserts value is tf.io.WeightsManifestEntry {
  if (!isPlainObject(value)) {
    throw new ModelArchiveError(`${path} 必须是对象`);
  }
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 500) {
    throw new ModelArchiveError(`${path}.name 无效`);
  }
  if (
    !Array.isArray(value.shape) ||
    value.shape.length > 12 ||
    value.shape.some((dimension) => !Number.isInteger(dimension) || (dimension as number) < 0)
  ) {
    throw new ModelArchiveError(`${path}.shape 无效`);
  }
  if (!["float32", "int32", "bool", "complex64"].includes(value.dtype as string)) {
    throw new ModelArchiveError(`${path}.dtype 无效`);
  }
  if (value.group !== undefined && value.group !== "model" && value.group !== "optimizer") {
    throw new ModelArchiveError(`${path}.group 无效`);
  }
  if (value.quantization !== undefined) {
    if (
      !isPlainObject(value.quantization) ||
      !["uint8", "uint16", "float16"].includes(value.quantization.dtype as string)
    ) {
      throw new ModelArchiveError(`${path}.quantization 无效`);
    }
  }
}

function assertWeightDataMatchesSpecs(
  specs: readonly tf.io.WeightsManifestEntry[],
  byteLength: number,
): void {
  let expectedBytes = 0;
  for (const spec of specs) {
    let elements = 1;
    for (const dimension of spec.shape) {
      elements *= dimension;
      if (!Number.isSafeInteger(elements) || elements > MODEL_LIMITS.maxWeightsBytes * 8) {
        throw new ModelArchiveError(`权重 ${spec.name} 的 shape 过大`);
      }
    }
    const bytesPerElement = spec.quantization
      ? spec.quantization.dtype === "uint8" ? 1 : 2
      : spec.dtype === "bool" ? 1
        : spec.dtype === "complex64" ? 8
          : 4;
    expectedBytes += elements * bytesPerElement;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MODEL_LIMITS.maxWeightsBytes) {
      throw new ModelArchiveError("权重清单声明的数据超过大小限制");
    }
  }
  if (expectedBytes !== byteLength) {
    throw new ModelArchiveError("weights.bin 大小与模型权重清单不一致");
  }
}

function validateModelArtifacts(artifacts: tf.io.ModelArtifacts): void {
  if (!isPlainObject(artifacts.modelTopology)) {
    throw new ModelArchiveError("仅支持 JSON topology 的 TensorFlow.js LayersModel");
  }
  if (!Array.isArray(artifacts.weightSpecs) || artifacts.weightSpecs.length > 100_000) {
    throw new ModelArchiveError("模型权重清单缺失或过大");
  }
  artifacts.weightSpecs.forEach((spec, index) => assertWeightSpec(spec, `weightSpecs[${index}]`));
}

function serializedModelJson(artifacts: tf.io.ModelArtifacts): tf.io.ModelJSON {
  validateModelArtifacts(artifacts);
  return {
    modelTopology: artifacts.modelTopology as Record<string, unknown>,
    trainingConfig: artifacts.trainingConfig,
    weightsManifest: [
      {
        paths: [CLASSIFIER_MODEL_FILES.weights],
        weights: artifacts.weightSpecs ?? [],
      },
    ],
    format: artifacts.format ?? "layers-model",
    generatedBy: artifacts.generatedBy ?? `TensorFlow.js ${tf.version.tfjs}`,
    convertedBy: artifacts.convertedBy ?? null,
    signature: artifacts.signature,
    userDefinedMetadata: artifacts.userDefinedMetadata,
    modelInitializer: artifacts.modelInitializer,
    initializerSignature: artifacts.initializerSignature,
  };
}

function parseJson(text: string, fileName: string, maxBytes: number): unknown {
  if (utf8ByteLength(text) > maxBytes) {
    throw new ModelArchiveError(`${fileName} 超过大小限制`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ModelArchiveError(`${fileName} 不是有效 JSON`, { cause: error });
  }
}

function parseModelJson(text: string): tf.io.ModelJSON {
  const value = parseJson(text, CLASSIFIER_MODEL_FILES.model, MODEL_LIMITS.maxModelJsonBytes);
  if (!isPlainObject(value) || !isPlainObject(value.modelTopology)) {
    throw new ModelArchiveError("model.json 缺少有效 modelTopology");
  }
  if (!Array.isArray(value.weightsManifest) || value.weightsManifest.length !== 1) {
    throw new ModelArchiveError("model.json 必须包含一个权重清单");
  }
  const group = value.weightsManifest[0] as unknown;
  if (
    !isPlainObject(group) ||
    !Array.isArray(group.paths) ||
    group.paths.length !== 1 ||
    group.paths[0] !== CLASSIFIER_MODEL_FILES.weights ||
    !Array.isArray(group.weights) ||
    group.weights.length > 100_000
  ) {
    throw new ModelArchiveError("model.json 的 weightsManifest 无效");
  }
  group.weights.forEach((spec, index) => assertWeightSpec(spec, `weightsManifest[0].weights[${index}]`));
  return value as unknown as tf.io.ModelJSON;
}

function artifactsFromModelJson(modelJson: tf.io.ModelJSON, weights: Uint8Array): tf.io.ModelArtifacts {
  const manifest = modelJson.weightsManifest[0];
  return {
    modelTopology: modelJson.modelTopology,
    trainingConfig: modelJson.trainingConfig,
    weightSpecs: manifest.weights,
    weightData: copyArrayBuffer(weights),
    format: modelJson.format,
    generatedBy: modelJson.generatedBy,
    convertedBy: modelJson.convertedBy,
    signature: modelJson.signature,
    userDefinedMetadata: modelJson.userDefinedMetadata,
    modelInitializer: modelJson.modelInitializer,
    initializerSignature: modelJson.initializerSignature,
  };
}

function assertSafeModelEntries(archive: JSZip): void {
  const files = Object.values(archive.files).filter((entry) => !entry.dir);
  const expected = new Set<string>(Object.values(CLASSIFIER_MODEL_FILES));
  if (files.length !== expected.size) {
    throw new ModelArchiveError("模型包必须且只能包含 model.json、weights.bin、metadata.json");
  }
  for (const entry of files) {
    if (
      !expected.has(entry.name) ||
      entry.name.includes("/") ||
      entry.name.includes("\\") ||
      (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)
    ) {
      throw new ModelArchiveError(`模型包包含不安全或未知文件：${entry.unsafeOriginalName ?? entry.name}`);
    }
    const declaredSize = declaredUncompressedSize(entry);
    const limit = entry.name === CLASSIFIER_MODEL_FILES.weights
      ? MODEL_LIMITS.maxWeightsBytes
      : entry.name === CLASSIFIER_MODEL_FILES.model
        ? MODEL_LIMITS.maxModelJsonBytes
        : MODEL_LIMITS.maxMetadataBytes;
    if (declaredSize !== undefined && declaredSize > limit) {
      throw new ModelArchiveError(`${entry.name} 超过解压大小限制`);
    }
  }
}

export async function exportClassifierModelZip(
  source: ClassifierModelSource,
  metadata: ClassifierModelMetadata,
): Promise<Blob> {
  validateClassifierMetadata(metadata);
  const artifacts = isLayersModel(source) ? await captureModelArtifacts(source) : source;
  validateModelArtifacts(artifacts);
  const weights = normalizeWeightData(artifacts.weightData);
  if (weights.byteLength < 1 || weights.byteLength > MODEL_LIMITS.maxWeightsBytes) {
    throw new ModelArchiveError("模型权重为空或超过大小限制");
  }
  assertWeightDataMatchesSpecs(artifacts.weightSpecs ?? [], weights.byteLength);

  const modelJson = JSON.stringify(serializedModelJson(artifacts), null, 2);
  const metadataJson = JSON.stringify(metadata, null, 2);
  if (utf8ByteLength(modelJson) > MODEL_LIMITS.maxModelJsonBytes) {
    throw new ModelArchiveError("model.json 超过大小限制");
  }
  if (utf8ByteLength(metadataJson) > MODEL_LIMITS.maxMetadataBytes) {
    throw new ModelArchiveError("metadata.json 超过大小限制");
  }

  const archive = new JSZip();
  archive.file(CLASSIFIER_MODEL_FILES.model, modelJson);
  archive.file(CLASSIFIER_MODEL_FILES.weights, weights, {
    binary: true,
    compression: "STORE",
  });
  archive.file(CLASSIFIER_MODEL_FILES.metadata, metadataJson);
  const blob = await archive.generateAsync({
    type: "blob",
    mimeType: CLASSIFIER_MODEL_MIME_TYPE,
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  if (blob.size > MODEL_LIMITS.maxArchiveBytes) {
    throw new ModelArchiveError("生成的模型包超过大小限制");
  }
  return blob;
}

export async function importClassifierModelZip(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<ImportedClassifierModel> {
  const byteLength = inputByteLength(input);
  if (byteLength < 1 || byteLength > MODEL_LIMITS.maxArchiveBytes) {
    throw new ModelArchiveError("模型包为空或超过大小限制");
  }

  let archive: JSZip;
  try {
    const zipInput = "size" in input ? await input.arrayBuffer() : input;
    archive = await JSZip.loadAsync(zipInput, { checkCRC32: false, createFolders: false });
  } catch (error) {
    throw new ModelArchiveError("无法读取模型 ZIP 包", { cause: error });
  }
  assertSafeModelEntries(archive);

  const modelEntry = archive.file(CLASSIFIER_MODEL_FILES.model);
  const weightsEntry = archive.file(CLASSIFIER_MODEL_FILES.weights);
  const metadataEntry = archive.file(CLASSIFIER_MODEL_FILES.metadata);
  if (!modelEntry || !weightsEntry || !metadataEntry) {
    throw new ModelArchiveError("模型包文件不完整");
  }

  const modelJson = parseModelJson(await modelEntry.async("string"));
  const metadataValue = parseJson(
    await metadataEntry.async("string"),
    CLASSIFIER_MODEL_FILES.metadata,
    MODEL_LIMITS.maxMetadataBytes,
  );
  try {
    validateClassifierMetadata(metadataValue);
  } catch (error) {
    throw new ModelArchiveError("模型元数据校验失败", { cause: error });
  }

  const weights = await weightsEntry.async("uint8array");
  if (weights.byteLength < 1 || weights.byteLength > MODEL_LIMITS.maxWeightsBytes) {
    throw new ModelArchiveError("weights.bin 为空或超过大小限制");
  }
  const artifacts = artifactsFromModelJson(modelJson, weights);
  assertWeightDataMatchesSpecs(artifacts.weightSpecs ?? [], weights.byteLength);
  let model: tf.LayersModel;
  try {
    model = await tf.loadLayersModel(tf.io.fromMemory(artifacts));
  } catch (error) {
    throw new ModelArchiveError("TensorFlow.js 无法加载该模型", { cause: error });
  }
  const outputUnits = model.outputs.length === 1 ? model.outputs[0].shape.at(-1) : undefined;
  if (outputUnits !== metadataValue.labels.length) {
    model.dispose();
    throw new ModelArchiveError("模型输出数量与 metadata.json 的标签数量不一致");
  }
  return { model, artifacts, metadata: metadataValue };
}

export function classifierModelArchiveFileName(modelName: string): string {
  return `${sanitizeFilename(modelName, "classifier")}.tm-model.zip`;
}

/**
 * Adapter for the app's MobileNet classifier runtime. The ZIP remains the
 * standard three-file package; runtime-only values are recoverable from the
 * classifier head and the validated package metadata.
 */
export async function exportModelArchive(
  bundle: ClassifierModelBundle,
  metadata: ClassifierModelMetadata,
): Promise<Blob> {
  validateClassifierModelBundle(bundle);
  const metadataLabels = metadata.labels.map((label) => label.name);
  if (
    bundle.labels.length !== metadataLabels.length ||
    bundle.labels.some((label, index) => label !== metadataLabels[index])
  ) {
    throw new ModelArchiveError("运行时模型标签与项目标签不一致");
  }
  return exportClassifierModelZip(bundle.artifacts, metadata);
}

export interface ImportedModelArchive {
  bundle: ClassifierModelBundle;
  metadata: ClassifierModelMetadata;
}

export async function importModelArchive(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<ImportedModelArchive> {
  const imported = await importClassifierModelZip(input);
  try {
    const inputShape = imported.model.inputs.length === 1
      ? imported.model.inputs[0].shape
      : undefined;
    const embeddingSize = inputShape?.length === 2 ? inputShape[1] : undefined;
    if (
      embeddingSize !== 1280
      || imported.metadata.imageSize !== 224
      || imported.metadata.featureExtractor !== "MobileNet v2 alpha 0.5 embedding"
    ) {
      throw new ModelArchiveError("模型不是可导入的 MobileNet 特征分类头");
    }
    const bundle: ClassifierModelBundle = {
      format: "teachable-image-classifier",
      version: 1,
      createdAt: imported.metadata.createdAt,
      labels: imported.metadata.labels.map((label) => label.name),
      featureExtractor: {
        name: "MobileNet",
        version: 2,
        alpha: 0.5,
        embeddingSize: embeddingSize as number,
      },
      artifacts: imported.artifacts,
    };
    validateClassifierModelBundle(bundle);
    return { bundle, metadata: imported.metadata };
  } finally {
    imported.model.dispose();
  }
}
