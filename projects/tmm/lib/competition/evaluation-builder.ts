import JSZip from "jszip";

import { createImageClassifier } from "../ml";
import type { CompetitionDivision } from "./types";
import {
  COMPETITION_EMBEDDING_SIZE,
  COMPETITION_EVALUATION_FORMAT,
  COMPETITION_EVALUATION_VERSION,
  MAX_EVALUATION_SAMPLES,
  encodeEvaluationEmbeddings,
  type CompetitionEvaluationSet,
  validateCompetitionEvaluationSet,
} from "./evaluation-format";
import { requireOrangeCompetitionLabels } from "./rules";

const MAX_EVALUATION_ARCHIVE_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTENSION = /\.(jpe?g|png|webp)$/i;

export interface EvaluationBuildProgress {
  completed: number;
  total: number;
  label: string | null;
  fileName: string | null;
}

interface EvaluationImageEntry {
  path: string;
  label: string;
  file: JSZip.JSZipObject;
}

interface CollectedEvaluationArchive {
  entries: EvaluationImageEntry[];
  labels: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("测试集处理已停止。", "AbortError");
}

function imageMimeType(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
}

function blobToDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const onAbort = () => {
      reader.abort();
      reject(new DOMException("测试集处理已停止。", "AbortError"));
    };
    reader.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new TypeError("测试图片无法读取。 "));
    };
    reader.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(reader.error ?? new Error("测试图片无法读取。 "));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.readAsDataURL(blob);
  });
}

function normalizedPathSegments(path: string): string[] {
  if (path.includes("\\") || path.startsWith("/") || path.includes("\0")) {
    throw new TypeError(`测试集包含不安全路径：${path}`);
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new TypeError(`测试集包含不安全路径：${path}`);
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLabel(value: unknown, source: string): string {
  if (typeof value !== "string") throw new TypeError(`${source} 缺少有效的类别名称。`);
  const label = value.normalize("NFKC").trim();
  if (!label || label.length > 80) throw new RangeError(`类别名称无效：${value}`);
  return label;
}

function assertEvaluationEntryCount(entries: readonly EvaluationImageEntry[]): void {
  if (entries.length < 2) throw new RangeError("测试集 ZIP 至少需要两张图片。 ");
  if (entries.length > MAX_EVALUATION_SAMPLES) {
    throw new RangeError(`测试集最多支持 ${MAX_EVALUATION_SAMPLES} 张图片。`);
  }
}

async function collectProjectArchiveEntries(
  archive: JSZip,
): Promise<CollectedEvaluationArchive | null> {
  const manifestEntry = archive.file("project.json");
  if (!manifestEntry) return null;

  let manifest: unknown;
  try {
    manifest = JSON.parse(await manifestEntry.async("string")) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(manifest)
    || manifest.format !== "tm-object-project-archive"
    || manifest.formatVersion !== 1
  ) return null;
  if (!isRecord(manifest.project) || !Array.isArray(manifest.project.classes)) {
    throw new TypeError("识物项目备份缺少类别列表。 ");
  }
  if (manifest.project.classes.length !== 2) {
    throw new RangeError("识物项目备份必须且只能包含“橙子”和“非橙子”两个类别。 ");
  }

  const labels: string[] = [];
  const entries: EvaluationImageEntry[] = [];
  const referencedPaths = new Set<string>();
  for (const [classIndex, classValue] of manifest.project.classes.entries()) {
    if (!isRecord(classValue) || !Array.isArray(classValue.samples)) {
      throw new TypeError(`识物项目备份的类别 ${classIndex + 1} 格式无效。`);
    }
    const label = normalizeLabel(classValue.name, `类别 ${classIndex + 1}`);
    if (labels.includes(label)) throw new RangeError(`识物项目备份的类别名称重复：${label}`);
    labels.push(label);
    if (classValue.samples.length === 0) {
      throw new RangeError(`测试集类别“${label}”至少需要一张图片。`);
    }
    for (const [sampleIndex, sampleValue] of classValue.samples.entries()) {
      if (!isRecord(sampleValue) || typeof sampleValue.imagePath !== "string") {
        throw new TypeError(`类别“${label}”的第 ${sampleIndex + 1} 个样本缺少图片路径。`);
      }
      const imagePath = sampleValue.imagePath;
      normalizedPathSegments(imagePath);
      if (!IMAGE_EXTENSION.test(imagePath) || referencedPaths.has(imagePath)) {
        throw new TypeError(`识物项目备份包含无效或重复的图片路径：${imagePath}`);
      }
      const file = archive.file(imagePath);
      if (!file) throw new TypeError(`识物项目备份缺少图片：${imagePath}`);
      const unsafeName = (file as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
      if (unsafeName && unsafeName !== file.name) throw new TypeError(`测试集包含不安全路径：${unsafeName}`);
      referencedPaths.add(imagePath);
      entries.push({ file, path: imagePath, label });
    }
  }
  assertEvaluationEntryCount(entries);
  return { entries, labels };
}

function collectFolderArchiveEntries(archive: JSZip): CollectedEvaluationArchive {
  const candidates = Object.values(archive.files)
    .filter((entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && !entry.name.split("/").some((part) => part.startsWith(".")))
    .map((file) => ({ file, path: file.name, parts: normalizedPathSegments(file.name) }))
    .filter(({ path }) => IMAGE_EXTENSION.test(path));
  if (candidates.length < 2) throw new RangeError("测试集 ZIP 至少需要两张图片。 ");
  const minimumDirectoryDepth = Math.min(...candidates.map(({ parts }) => parts.length - 1));
  let sharedDirectoryDepth = 0;
  while (
    sharedDirectoryDepth < minimumDirectoryDepth - 1
    && candidates.every(({ parts }) => parts[sharedDirectoryDepth] === candidates[0].parts[sharedDirectoryDepth])
  ) sharedDirectoryDepth += 1;
  const entries = candidates.map(({ file, path, parts }) => {
    const unsafeName = (file as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
    if (unsafeName && unsafeName !== file.name) throw new TypeError(`测试集包含不安全路径：${unsafeName}`);
    const relative = parts.slice(sharedDirectoryDepth);
    if (relative.length < 2) throw new TypeError(`图片必须放在类别文件夹内：${path}`);
    const label = normalizeLabel(relative[0], "类别文件夹");
    return { file, path, label };
  });
  entries.sort((left, right) => left.label.localeCompare(right.label, "zh-CN") || left.path.localeCompare(right.path, "zh-CN"));
  assertEvaluationEntryCount(entries);
  return { entries, labels: Array.from(new Set(entries.map(({ label }) => label))) };
}

async function collectEvaluationEntries(archive: JSZip): Promise<CollectedEvaluationArchive> {
  const collected = await collectProjectArchiveEntries(archive) ?? collectFolderArchiveEntries(archive);
  requireOrangeCompetitionLabels(collected.labels, "测试集类别");
  return collected;
}

export async function inspectCompetitionEvaluationArchive(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<{ labels: string[]; entries: Array<{ path: string; label: string }> }> {
  const bytes = input instanceof Blob ? await input.arrayBuffer() : input;
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const collected = await collectEvaluationEntries(archive);
  return {
    labels: collected.labels,
    entries: collected.entries.map(({ path, label }) => ({ path, label })),
  };
}

export async function buildCompetitionEvaluationSet(
  file: File,
  division: CompetitionDivision,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: EvaluationBuildProgress) => void;
  } = {},
): Promise<CompetitionEvaluationSet> {
  if (file.size < 1 || file.size > MAX_EVALUATION_ARCHIVE_BYTES) {
    throw new RangeError("测试集 ZIP 大小必须在 1 字节至 100 MiB 之间。 ");
  }
  throwIfAborted(options.signal);
  const archive = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true, createFolders: false });
  const { entries, labels } = await collectEvaluationEntries(archive);
  const labelIndexes = new Map(labels.map((label, index) => [label, index]));
  const sampleLabelIndexes = entries.map(({ label }) => labelIndexes.get(label) as number);
  const flattened = new Float32Array(entries.length * COMPETITION_EMBEDDING_SIZE);
  const classifier = createImageClassifier();
  try {
    options.onProgress?.({ completed: 0, total: entries.length, label: null, fileName: null });
    await classifier.initialize(options.signal);
    for (let index = 0; index < entries.length; index += 1) {
      throwIfAborted(options.signal);
      const entry = entries[index];
      const raw = await entry.file.async("uint8array");
      if (raw.byteLength > 15 * 1024 * 1024) throw new RangeError(`图片过大：${entry.path}`);
      const blob = new Blob([raw], { type: imageMimeType(entry.path) });
      const embedding = await classifier.extractEmbedding(await blobToDataUrl(blob, options.signal), options.signal);
      if (embedding.length !== COMPETITION_EMBEDDING_SIZE) throw new RangeError(`图片 ${entry.path} 的特征维度不是 1280。`);
      flattened.set(embedding, index * COMPETITION_EMBEDDING_SIZE);
      options.onProgress?.({ completed: index + 1, total: entries.length, label: entry.label, fileName: entry.path });
    }
  } finally {
    classifier.dispose();
  }

  return validateCompetitionEvaluationSet({
    format: COMPETITION_EVALUATION_FORMAT,
    version: COMPETITION_EVALUATION_VERSION,
    division,
    createdAt: new Date().toISOString(),
    featureExtractor: "mobilenet-v2-alpha-0.5-embedding",
    preprocessing: "center-crop-224-rgb-v1",
    embeddingSize: COMPETITION_EMBEDDING_SIZE,
    labels,
    sampleLabelIndexes,
    embeddingsBase64: encodeEvaluationEmbeddings(flattened),
  });
}
