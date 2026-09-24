import type { CompetitionDivision } from "./types";
import { requireOrangeCompetitionLabels } from "./rules";

export const COMPETITION_EVALUATION_FORMAT = "tm-competition-evaluation" as const;
export const COMPETITION_EVALUATION_VERSION = 1 as const;
export const COMPETITION_EMBEDDING_SIZE = 1280;
export const MAX_EVALUATION_SAMPLES = 600;

const DIVISIONS = new Set<CompetitionDivision>(["primary", "junior", "senior"]);

export interface CompetitionEvaluationSet {
  format: typeof COMPETITION_EVALUATION_FORMAT;
  version: typeof COMPETITION_EVALUATION_VERSION;
  division: CompetitionDivision;
  createdAt: string;
  featureExtractor: "mobilenet-v2-alpha-0.5-embedding";
  preprocessing: "center-crop-224-rgb-v1";
  embeddingSize: typeof COMPETITION_EMBEDDING_SIZE;
  labels: string[];
  sampleLabelIndexes: number[];
  /** Little-endian Float32 values, sample-major, encoded as base64. */
  embeddingsBase64: string;
}

function decodeBase64(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError("测试集的特征数据不是有效 Base64。 ");
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch (error) {
    throw new TypeError("测试集的特征数据无法解码。", { cause: error });
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 32_768;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function encodeEvaluationEmbeddings(values: Float32Array): string {
  const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new RangeError(`第 ${index + 1} 个特征值不是有限数字。`);
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  });
  return encodeBase64(bytes);
}

export function decodeEvaluationEmbeddings(
  source: Pick<CompetitionEvaluationSet, "embeddingsBase64" | "sampleLabelIndexes" | "embeddingSize">,
): Float32Array {
  const bytes = decodeBase64(source.embeddingsBase64);
  const expectedBytes = source.sampleLabelIndexes.length
    * source.embeddingSize
    * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedBytes) {
    throw new RangeError(`测试集特征长度错误：应为 ${expectedBytes} 字节，实际为 ${bytes.byteLength} 字节。`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(expectedBytes / Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < values.length; index += 1) {
    const value = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(value)) throw new RangeError(`第 ${index + 1} 个测试特征值无效。`);
    values[index] = value;
  }
  return values;
}

export function validateCompetitionEvaluationSet(value: unknown): CompetitionEvaluationSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("测试集必须是对象。 ");
  }
  const source = value as Partial<CompetitionEvaluationSet>;
  if (source.format !== COMPETITION_EVALUATION_FORMAT || source.version !== COMPETITION_EVALUATION_VERSION) {
    throw new TypeError("测试集格式或版本不受支持。 ");
  }
  if (!source.division || !DIVISIONS.has(source.division)) throw new TypeError("测试集组别无效。 ");
  if (!source.createdAt || !Number.isFinite(Date.parse(source.createdAt))) throw new TypeError("测试集时间无效。 ");
  if (source.featureExtractor !== "mobilenet-v2-alpha-0.5-embedding") {
    throw new TypeError("测试集不是指定的 MobileNet v2 特征。 ");
  }
  if (source.preprocessing !== "center-crop-224-rgb-v1") throw new TypeError("测试集预处理版本不受支持。 ");
  if (source.embeddingSize !== COMPETITION_EMBEDDING_SIZE) throw new RangeError("测试集特征维度必须为 1280。 ");
  const labels = requireOrangeCompetitionLabels(source.labels, "测试集类别");
  if (
    !Array.isArray(source.sampleLabelIndexes)
    || source.sampleLabelIndexes.length < labels.length
    || source.sampleLabelIndexes.length > MAX_EVALUATION_SAMPLES
  ) {
    throw new RangeError(`测试集样本数必须在 ${labels.length}–${MAX_EVALUATION_SAMPLES} 之间。`);
  }
  const sampleLabelIndexes = source.sampleLabelIndexes.map((classIndex, sampleIndex) => {
    if (!Number.isInteger(classIndex) || classIndex < 0 || classIndex >= labels.length) {
      throw new RangeError(`第 ${sampleIndex + 1} 个测试样本类别索引无效。`);
    }
    return classIndex;
  });
  const support = Array.from({ length: labels.length }, () => 0);
  sampleLabelIndexes.forEach((classIndex) => { support[classIndex] += 1; });
  if (support.some((count) => count === 0)) throw new RangeError("测试集的每个类别至少需要一张图片。 ");
  if (typeof source.embeddingsBase64 !== "string") throw new TypeError("测试集缺少特征数据。 ");

  const normalized: CompetitionEvaluationSet = {
    format: COMPETITION_EVALUATION_FORMAT,
    version: COMPETITION_EVALUATION_VERSION,
    division: source.division,
    createdAt: source.createdAt,
    featureExtractor: source.featureExtractor,
    preprocessing: source.preprocessing,
    embeddingSize: source.embeddingSize,
    labels,
    sampleLabelIndexes,
    embeddingsBase64: source.embeddingsBase64,
  };
  decodeEvaluationEmbeddings(normalized);
  return normalized;
}
