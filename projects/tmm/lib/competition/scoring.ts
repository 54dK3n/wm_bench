import JSZip from "jszip";

import type { ClassifierModelMetadata } from "../project/types";
import { validateClassifierMetadata } from "../project/validation";
import {
  COMPETITION_EMBEDDING_SIZE,
  decodeEvaluationEmbeddings,
  type CompetitionEvaluationSet,
  validateCompetitionEvaluationSet,
} from "./evaluation-format";
import { requireOrangeCompetitionLabels } from "./rules";

export const COMPETITION_EVALUATOR_VERSION = "orange-balanced-v2";
export const MAX_COMPETITION_MODEL_BYTES = 2 * 1024 * 1024;

const MAX_MODEL_JSON_BYTES = 512 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_WEIGHTS_BYTES = 768 * 1024;
const HIDDEN_UNITS = 100;
const EXPECTED_FEATURE_EXTRACTOR = "MobileNet v2 alpha 0.5 embedding";
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;

interface ParsedClassifierHead {
  metadata: ClassifierModelMetadata;
  kernelOne: Float32Array;
  biasOne: Float32Array;
  kernelTwo: Float32Array;
  biasTwo: Float32Array;
}

export interface CompetitionClassScore {
  label: string;
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CompetitionScoreResult {
  evaluatorVersion: typeof COMPETITION_EVALUATOR_VERSION;
  artifactSha256: string;
  artifactBytes: number;
  modelName: string;
  labels: string[];
  rankingMetric: "balancedAccuracy";
  scoreMicros: number;
  accuracy: number;
  macroF1: number;
  balancedAccuracy: number;
  correctCount: number;
  totalCount: number;
  confusionMatrix: number[][];
  perClass: CompetitionClassScore[];
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function bytesToText(bytes: Uint8Array, fileName: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`${fileName} 不是有效 UTF-8 文本。`, { cause: error });
  }
}

function parseJson(bytes: Uint8Array, fileName: string): unknown {
  try {
    return JSON.parse(bytesToText(bytes, fileName)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError(`${fileName} 不是有效 JSON。`, { cause: error });
    throw error;
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new TypeError("模型文件不是完整的 ZIP。 ");
}

function inspectZipDirectory(bytes: Uint8Array): Map<string, { compressed: number; uncompressed: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new TypeError("不支持分卷或 ZIP64 模型包。 ");
  }
  if (entryCount !== 3 || centralOffset + centralSize > eocd) {
    throw new TypeError("模型包必须且只能包含三个文件。 ");
  }

  const entries = new Map<string, { compressed: number; uncompressed: number }>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new TypeError("模型 ZIP 中央目录损坏。 ");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || flags & 0x1 || (method !== 0 && method !== 8)) {
      throw new TypeError("模型 ZIP 使用了不受支持或加密的条目。 ");
    }
    const name = bytesToText(bytes.subarray(offset + 46, offset + 46 + nameLength), "ZIP 文件名");
    if (!/^(model\.json|weights\.bin|metadata\.json)$/.test(name) || entries.has(name)) {
      throw new TypeError(`模型 ZIP 包含未知、重复或不安全的文件：${name}`);
    }
    if (uncompressed > Math.max(1_024, compressed * 100)) throw new RangeError(`${name} 压缩比异常。`);
    entries.set(name, { compressed, uncompressed });
    totalUncompressed += uncompressed;
    offset = end;
  }
  if (offset !== centralOffset + centralSize || entries.size !== 3) throw new TypeError("模型 ZIP 中央目录与声明不一致。 ");
  if ((entries.get("model.json")?.uncompressed ?? Infinity) > MAX_MODEL_JSON_BYTES) throw new RangeError("model.json 过大。 ");
  if ((entries.get("metadata.json")?.uncompressed ?? Infinity) > MAX_METADATA_BYTES) throw new RangeError("metadata.json 过大。 ");
  if ((entries.get("weights.bin")?.uncompressed ?? Infinity) > MAX_WEIGHTS_BYTES) throw new RangeError("weights.bin 过大。 ");
  if (totalUncompressed > MAX_MODEL_JSON_BYTES + MAX_METADATA_BYTES + MAX_WEIGHTS_BYTES) {
    throw new RangeError("模型解压后的总体积过大。 ");
  }
  return entries;
}

function assertShape(value: unknown, expected: readonly number[], path: string): void {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new TypeError(`${path} 形状必须为 [${expected.join(", ")}]。`);
  }
}

function parseWeightSpecs(modelJson: unknown, classCount: number): Array<{ name: string; shape: number[] }> {
  if (!modelJson || typeof modelJson !== "object" || Array.isArray(modelJson)) throw new TypeError("model.json 顶层格式无效。 ");
  const source = modelJson as { modelTopology?: unknown; weightsManifest?: unknown };
  if (!source.modelTopology || typeof source.modelTopology !== "object" || Array.isArray(source.modelTopology)) {
    throw new TypeError("model.json 缺少模型结构。 ");
  }
  if (!Array.isArray(source.weightsManifest) || source.weightsManifest.length !== 1) {
    throw new TypeError("model.json 必须包含一个权重清单。 ");
  }
  const manifest = source.weightsManifest[0] as { paths?: unknown; weights?: unknown };
  if (!Array.isArray(manifest.paths) || manifest.paths.length !== 1 || manifest.paths[0] !== "weights.bin") {
    throw new TypeError("模型权重清单必须指向 weights.bin。 ");
  }
  if (!Array.isArray(manifest.weights) || manifest.weights.length !== 4) {
    throw new TypeError("比赛模型必须是标准的四组权重分类头。 ");
  }
  const specs = manifest.weights.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`权重 ${index + 1} 声明无效。`);
    const spec = value as { name?: unknown; shape?: unknown; dtype?: unknown; quantization?: unknown };
    if (typeof spec.name !== "string" || spec.dtype !== "float32" || spec.quantization !== undefined) {
      throw new TypeError(`权重 ${index + 1} 必须是未量化 float32。`);
    }
    return { name: spec.name, shape: spec.shape as number[] };
  });
  assertShape(specs[0].shape, [COMPETITION_EMBEDDING_SIZE, HIDDEN_UNITS], "第一层 kernel");
  assertShape(specs[1].shape, [HIDDEN_UNITS], "第一层 bias");
  assertShape(specs[2].shape, [HIDDEN_UNITS, classCount], "输出层 kernel");
  assertShape(specs[3].shape, [classCount], "输出层 bias");
  if (!/kernel$/i.test(specs[0].name) || !/bias$/i.test(specs[1].name) || !/kernel$/i.test(specs[2].name) || !/bias$/i.test(specs[3].name)) {
    throw new TypeError("模型权重顺序不是标准 Dense 分类头。 ");
  }
  return specs;
}

function decodeFloatWeights(bytes: Uint8Array, floatCount: number): Float32Array {
  if (bytes.byteLength !== floatCount * Float32Array.BYTES_PER_ELEMENT) {
    throw new RangeError("weights.bin 大小与标准分类头不一致。 ");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(floatCount);
  for (let index = 0; index < values.length; index += 1) {
    const value = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(value)) throw new RangeError(`模型第 ${index + 1} 个权重无效。`);
    values[index] = value;
  }
  return values;
}

function sliceCopy(values: Float32Array, start: number, end: number): Float32Array {
  const copy = new Float32Array(end - start);
  copy.set(values.subarray(start, end));
  return copy;
}

async function parseClassifierHead(bytes: Uint8Array): Promise<ParsedClassifierHead> {
  inspectZipDirectory(bytes);
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const names = Object.values(archive.files).filter((entry) => !entry.dir).map((entry) => entry.name);
  if (names.length !== 3 || new Set(names).size !== 3) throw new TypeError("模型 ZIP 文件清单无效。 ");
  const modelEntry = archive.file("model.json");
  const metadataEntry = archive.file("metadata.json");
  const weightsEntry = archive.file("weights.bin");
  if (!modelEntry || !metadataEntry || !weightsEntry) throw new TypeError("模型 ZIP 文件不完整。 ");

  const [modelBytes, metadataBytes, weightBytes] = await Promise.all([
    modelEntry.async("uint8array"),
    metadataEntry.async("uint8array"),
    weightsEntry.async("uint8array"),
  ]);
  if (modelBytes.byteLength > MAX_MODEL_JSON_BYTES || metadataBytes.byteLength > MAX_METADATA_BYTES || weightBytes.byteLength > MAX_WEIGHTS_BYTES) {
    throw new RangeError("模型解压后的文件超过比赛限制。 ");
  }
  const metadataValue = parseJson(metadataBytes, "metadata.json");
  validateClassifierMetadata(metadataValue);
  const metadata = metadataValue as ClassifierModelMetadata;
  if (metadata.imageSize !== 224 || metadata.featureExtractor !== EXPECTED_FEATURE_EXTRACTOR || !metadata.prediction) {
    throw new TypeError("只接受由当前识物工坊导出的 224px MobileNet v2 模型。 ");
  }
  requireOrangeCompetitionLabels(metadata.labels.map(({ name }) => name), "比赛模型类别");
  parseWeightSpecs(parseJson(modelBytes, "model.json"), metadata.labels.length);

  const kernelOneCount = COMPETITION_EMBEDDING_SIZE * HIDDEN_UNITS;
  const biasOneCount = HIDDEN_UNITS;
  const kernelTwoCount = HIDDEN_UNITS * metadata.labels.length;
  const biasTwoCount = metadata.labels.length;
  const allWeights = decodeFloatWeights(
    weightBytes,
    kernelOneCount + biasOneCount + kernelTwoCount + biasTwoCount,
  );
  let offset = 0;
  const kernelOne = sliceCopy(allWeights, offset, offset += kernelOneCount);
  const biasOne = sliceCopy(allWeights, offset, offset += biasOneCount);
  const kernelTwo = sliceCopy(allWeights, offset, offset += kernelTwoCount);
  const biasTwo = sliceCopy(allWeights, offset, offset + biasTwoCount);
  return { metadata, kernelOne, biasOne, kernelTwo, biasTwo };
}

function predictClassIndexes(head: ParsedClassifierHead, embeddings: Float32Array, sampleCount: number): number[] {
  const classCount = head.metadata.labels.length;
  const hidden = new Float64Array(HIDDEN_UNITS);
  const logits = new Float64Array(classCount);
  const predicted: number[] = [];

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    for (let hiddenIndex = 0; hiddenIndex < HIDDEN_UNITS; hiddenIndex += 1) hidden[hiddenIndex] = head.biasOne[hiddenIndex];
    const sampleOffset = sampleIndex * COMPETITION_EMBEDDING_SIZE;
    for (let inputIndex = 0; inputIndex < COMPETITION_EMBEDDING_SIZE; inputIndex += 1) {
      const input = embeddings[sampleOffset + inputIndex];
      const kernelOffset = inputIndex * HIDDEN_UNITS;
      for (let hiddenIndex = 0; hiddenIndex < HIDDEN_UNITS; hiddenIndex += 1) {
        hidden[hiddenIndex] += input * head.kernelOne[kernelOffset + hiddenIndex];
      }
    }
    for (let hiddenIndex = 0; hiddenIndex < HIDDEN_UNITS; hiddenIndex += 1) hidden[hiddenIndex] = Math.max(0, hidden[hiddenIndex]);
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) logits[classIndex] = head.biasTwo[classIndex];
    for (let hiddenIndex = 0; hiddenIndex < HIDDEN_UNITS; hiddenIndex += 1) {
      const activation = hidden[hiddenIndex];
      const kernelOffset = hiddenIndex * classCount;
      for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        logits[classIndex] += activation * head.kernelTwo[kernelOffset + classIndex];
      }
    }
    let bestIndex = 0;
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      if (!Number.isFinite(logits[classIndex])) throw new RangeError("模型产生了无效预测值。 ");
      if (logits[classIndex] > logits[bestIndex]) bestIndex = classIndex;
    }
    predicted.push(bestIndex);
  }
  return predicted;
}

function computeMetrics(labels: readonly string[], actual: readonly number[], predicted: readonly number[]) {
  const classCount = labels.length;
  const confusionMatrix = Array.from({ length: classCount }, () => Array.from({ length: classCount }, () => 0));
  actual.forEach((actualIndex, sampleIndex) => { confusionMatrix[actualIndex][predicted[sampleIndex]] += 1; });
  const support = confusionMatrix.map((row) => row.reduce((total, count) => total + count, 0));
  const predictedTotals = Array.from({ length: classCount }, (_, classIndex) => confusionMatrix.reduce((total, row) => total + row[classIndex], 0));
  const perClass = labels.map((label, classIndex) => {
    const truePositive = confusionMatrix[classIndex][classIndex];
    const precision = safeRatio(truePositive, predictedTotals[classIndex]);
    const recall = safeRatio(truePositive, support[classIndex]);
    return { label, support: support[classIndex], precision, recall, f1: safeRatio(2 * precision * recall, precision + recall) };
  });
  const correctCount = confusionMatrix.reduce((total, row, classIndex) => total + row[classIndex], 0);
  return {
    confusionMatrix,
    perClass,
    correctCount,
    accuracy: correctCount / actual.length,
    macroF1: perClass.reduce((total, item) => total + item.f1, 0) / classCount,
    balancedAccuracy: perClass.reduce((total, item) => total + item.recall, 0) / classCount,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function scoreCompetitionModel(
  input: ArrayBuffer | Uint8Array,
  evaluationInput: CompetitionEvaluationSet | unknown,
): Promise<CompetitionScoreResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_COMPETITION_MODEL_BYTES) {
    throw new RangeError(`比赛模型大小必须在 1 字节至 ${MAX_COMPETITION_MODEL_BYTES / 1024 / 1024} MiB 之间。`);
  }
  const evaluation = validateCompetitionEvaluationSet(evaluationInput);
  const [head, artifactSha256] = await Promise.all([parseClassifierHead(bytes), sha256Hex(bytes)]);
  const modelLabels = head.metadata.labels.map(({ name }) => name.normalize("NFKC").trim());
  if (new Set(modelLabels).size !== modelLabels.length || modelLabels.length !== evaluation.labels.length) {
    throw new TypeError("模型类别与该组测试集不一致。 ");
  }
  const modelIndexByLabel = new Map(modelLabels.map((label, index) => [label, index]));
  if (evaluation.labels.some((label) => !modelIndexByLabel.has(label))) {
    throw new TypeError("模型类别名称和数量必须与本组比赛要求完全一致。 ");
  }
  const embeddings = decodeEvaluationEmbeddings(evaluation);
  const actual = evaluation.sampleLabelIndexes.map((datasetClassIndex) => modelIndexByLabel.get(evaluation.labels[datasetClassIndex]) as number);
  const predicted = predictClassIndexes(head, embeddings, evaluation.sampleLabelIndexes.length);
  const metrics = computeMetrics(modelLabels, actual, predicted);
  return {
    evaluatorVersion: COMPETITION_EVALUATOR_VERSION,
    artifactSha256,
    artifactBytes: bytes.byteLength,
    modelName: head.metadata.name,
    labels: modelLabels,
    rankingMetric: "balancedAccuracy",
    scoreMicros: Math.round(metrics.balancedAccuracy * 1_000_000),
    totalCount: actual.length,
    ...metrics,
  };
}
