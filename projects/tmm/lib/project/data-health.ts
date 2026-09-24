import type { Project, ProjectClass, ProjectSample } from "./types";

export type DataHealthSeverity = "info" | "warning" | "error";

export type DataHealthIssueCode =
  | "insufficient-samples"
  | "below-recommended-samples"
  | "class-imbalance"
  | "exact-duplicate"
  | "cross-class-exact-duplicate"
  | "consecutive-camera-near-duplicate";

export type NearDuplicateAnalysis =
  | "not-needed"
  | "complete"
  | "partial"
  | "unavailable";

export interface DataHealthIssue {
  severity: DataHealthSeverity;
  code: DataHealthIssueCode;
  message: string;
  classIds: string[];
  sampleIds: string[];
}

export interface ClassDataHealth {
  classId: string;
  className: string;
  sampleCount: number;
  issues: DataHealthIssue[];
  nearDuplicateAnalysis: NearDuplicateAnalysis;
}

export interface ProjectDataHealth {
  totalSamples: number;
  globalIssues: DataHealthIssue[];
  classes: ClassDataHealth[];
  /** Global and per-class issues in display order. */
  issues: DataHealthIssue[];
  nearDuplicateAnalysis: NearDuplicateAnalysis;
}

export type PerceptualHashProvider = (
  sample: ProjectSample,
  signal?: AbortSignal,
) => Uint8Array | null | Promise<Uint8Array | null>;

export interface DataHealthOptions {
  signal?: AbortSignal;
  minimumSamplesPerClass?: number;
  recommendedSamplesPerClass?: number;
  /** Warn when the largest class is at least this multiple of the smallest. */
  imbalanceRatio?: number;
  /** Maximum bit differences for two perceptual hashes to be considered near duplicates. */
  nearDuplicateHammingDistance?: number;
  /** Only compare consecutive camera samples captured within this interval. */
  consecutiveCaptureWindowMs?: number;
  /** Optional deterministic provider, useful outside browsers or with precomputed hashes. */
  perceptualHashProvider?: PerceptualHashProvider;
}

interface NormalizedOptions {
  signal?: AbortSignal;
  minimumSamplesPerClass: number;
  recommendedSamplesPerClass: number;
  imbalanceRatio: number;
  nearDuplicateHammingDistance: number;
  consecutiveCaptureWindowMs: number;
  perceptualHashProvider: PerceptualHashProvider;
}

interface SampleReference {
  classId: string;
  sample: ProjectSample;
}

interface TimedSample {
  sample: ProjectSample;
  time: number;
  originalIndex: number;
}

const DEFAULT_MINIMUM_SAMPLES = 5;
const DEFAULT_RECOMMENDED_SAMPLES = 20;
const DEFAULT_IMBALANCE_RATIO = 2;
const DEFAULT_NEAR_DUPLICATE_DISTANCE = 6;
const DEFAULT_CAPTURE_WINDOW_MS = 2_500;
const PERCEPTUAL_HASH_WIDTH = 8;
const PERCEPTUAL_HASH_HEIGHT = 8;
const COOPERATIVE_YIELD_INTERVAL = 128;

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Data health analysis was cancelled.", "AbortError");
  }
  const error = new Error("Data health analysis was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function checkpoint(index: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (index > 0 && index % COOPERATIVE_YIELD_INTERVAL === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfAborted(signal);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

function normalizeOptions(options: DataHealthOptions): NormalizedOptions {
  const minimumSamplesPerClass = positiveInteger(
    options.minimumSamplesPerClass ?? DEFAULT_MINIMUM_SAMPLES,
    "minimumSamplesPerClass",
  );
  const recommendedSamplesPerClass = positiveInteger(
    options.recommendedSamplesPerClass ?? DEFAULT_RECOMMENDED_SAMPLES,
    "recommendedSamplesPerClass",
  );
  if (recommendedSamplesPerClass < minimumSamplesPerClass) {
    throw new RangeError("recommendedSamplesPerClass cannot be smaller than minimumSamplesPerClass.");
  }

  const imbalanceRatio = options.imbalanceRatio ?? DEFAULT_IMBALANCE_RATIO;
  if (!Number.isFinite(imbalanceRatio) || imbalanceRatio <= 1) {
    throw new RangeError("imbalanceRatio must be greater than one.");
  }

  const nearDuplicateHammingDistance =
    options.nearDuplicateHammingDistance ?? DEFAULT_NEAR_DUPLICATE_DISTANCE;
  if (
    !Number.isInteger(nearDuplicateHammingDistance) ||
    nearDuplicateHammingDistance < 0 ||
    nearDuplicateHammingDistance > 256
  ) {
    throw new RangeError("nearDuplicateHammingDistance must be an integer between 0 and 256.");
  }

  const consecutiveCaptureWindowMs =
    options.consecutiveCaptureWindowMs ?? DEFAULT_CAPTURE_WINDOW_MS;
  if (!Number.isFinite(consecutiveCaptureWindowMs) || consecutiveCaptureWindowMs < 0) {
    throw new RangeError("consecutiveCaptureWindowMs must be zero or greater.");
  }

  return {
    signal: options.signal,
    minimumSamplesPerClass,
    recommendedSamplesPerClass,
    imbalanceRatio,
    nearDuplicateHammingDistance,
    consecutiveCaptureWindowMs,
    perceptualHashProvider: options.perceptualHashProvider ?? createSamplePerceptualHash,
  };
}

/** A compact, non-cryptographic fingerprint used before exact string verification. */
function fingerprintDataUrl(dataUrl: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < dataUrl.length; index += 1) {
    const code = dataUrl.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${dataUrl.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

async function exactDuplicateGroups<T extends { sample: ProjectSample }>(
  references: readonly T[],
  signal?: AbortSignal,
): Promise<T[][]> {
  const fingerprintGroups = new Map<string, T[]>();
  for (let index = 0; index < references.length; index += 1) {
    await checkpoint(index, signal);
    const reference = references[index];
    const fingerprint = fingerprintDataUrl(reference.sample.dataUrl);
    const group = fingerprintGroups.get(fingerprint);
    if (group) group.push(reference);
    else fingerprintGroups.set(fingerprint, [reference]);
  }

  const duplicates: T[][] = [];
  let groupIndex = 0;
  for (const candidates of fingerprintGroups.values()) {
    await checkpoint(groupIndex, signal);
    groupIndex += 1;
    if (candidates.length < 2) continue;
    const verified = new Map<string, T[]>();
    for (const candidate of candidates) {
      const group = verified.get(candidate.sample.dataUrl);
      if (group) group.push(candidate);
      else verified.set(candidate.sample.dataUrl, [candidate]);
    }
    for (const group of verified.values()) {
      if (group.length > 1) duplicates.push(group);
    }
  }
  return duplicates;
}

function bitCount(value: number): number {
  let remaining = value & 0xff;
  remaining -= (remaining >>> 1) & 0x55;
  remaining = (remaining & 0x33) + ((remaining >>> 2) & 0x33);
  return (remaining + (remaining >>> 4)) & 0x0f;
}

export function perceptualHashDistance(
  left: Uint8Array,
  right: Uint8Array,
): number | null {
  if (left.length === 0 || left.length !== right.length) return null;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    distance += bitCount(left[index] ^ right[index]);
  }
  return distance;
}

function loadDataUrlImage(dataUrl: string, signal?: AbortSignal): Promise<HTMLImageElement | null> {
  if (
    typeof Image === "undefined" ||
    typeof document === "undefined" ||
    !/^data:image\/jpeg;base64,[a-z0-9+/]+={0,2}$/i.test(dataUrl)
  ) {
    return Promise.resolve(null);
  }
  throwIfAborted(signal);

  return new Promise<HTMLImageElement | null>((resolve, reject) => {
    const image = new Image();
    const cleanUp = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanUp();
      image.src = "";
      reject(createAbortError());
    };
    image.onload = () => {
      cleanUp();
      resolve(image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null);
    };
    image.onerror = () => {
      cleanUp();
      resolve(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    image.decoding = "async";
    image.src = dataUrl;
  });
}

/**
 * Creates a small average hash entirely on-device. It returns null when image
 * decoding APIs are unavailable, allowing callers to retain the basic checks.
 */
export async function createSamplePerceptualHash(
  sample: ProjectSample,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  throwIfAborted(signal);
  const image = await loadDataUrlImage(sample.dataUrl, signal);
  throwIfAborted(signal);
  if (!image || typeof document === "undefined") return null;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = PERCEPTUAL_HASH_WIDTH;
    canvas.height = PERCEPTUAL_HASH_HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, PERCEPTUAL_HASH_WIDTH, PERCEPTUAL_HASH_HEIGHT);
    const pixels = context.getImageData(
      0,
      0,
      PERCEPTUAL_HASH_WIDTH,
      PERCEPTUAL_HASH_HEIGHT,
    ).data;
    const luminance = new Uint8Array(PERCEPTUAL_HASH_WIDTH * PERCEPTUAL_HASH_HEIGHT);
    let total = 0;
    for (let index = 0; index < luminance.length; index += 1) {
      const offset = index * 4;
      const value = Math.round(
        (pixels[offset] * 299 + pixels[offset + 1] * 587 + pixels[offset + 2] * 114) / 1_000,
      );
      luminance[index] = value;
      total += value;
    }
    const average = total / luminance.length;
    const hash = new Uint8Array(1 + luminance.length / 8);
    const roundedAverage = Math.round(average);
    hash[0] = roundedAverage ^ (roundedAverage >>> 1);
    for (let index = 0; index < luminance.length; index += 1) {
      if (luminance[index] >= average) {
        hash[1 + Math.floor(index / 8)] |= 1 << (index % 8);
      }
    }
    throwIfAborted(signal);
    return hash;
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw createAbortError();
    return null;
  }
}

function timedCameraSamples(projectClass: ProjectClass): TimedSample[] {
  return projectClass.samples
    .map((sample, originalIndex) => ({
      sample,
      time: Date.parse(sample.createdAt),
      originalIndex,
    }))
    .filter((entry) => entry.sample.source === "camera" && Number.isFinite(entry.time))
    .sort((left, right) => left.time - right.time || left.originalIndex - right.originalIndex);
}

interface NearDuplicateResult {
  issues: DataHealthIssue[];
  analysis: NearDuplicateAnalysis;
}

async function analyzeConsecutiveCameraSamples(
  projectClass: ProjectClass,
  options: NormalizedOptions,
): Promise<NearDuplicateResult> {
  const cameraSamples = timedCameraSamples(projectClass);
  const pairs: Array<[ProjectSample, ProjectSample]> = [];
  for (let index = 1; index < cameraSamples.length; index += 1) {
    const previous = cameraSamples[index - 1];
    const current = cameraSamples[index];
    const gap = current.time - previous.time;
    if (
      gap <= options.consecutiveCaptureWindowMs &&
      previous.sample.dataUrl !== current.sample.dataUrl
    ) {
      pairs.push([previous.sample, current.sample]);
    }
  }
  if (pairs.length === 0) return { issues: [], analysis: "not-needed" };

  const hashes = new Map<string, Uint8Array | null>();
  const candidateIds = new Set(pairs.flatMap(([left, right]) => [left.id, right.id]));
  const hashFor = async (sample: ProjectSample): Promise<Uint8Array | null> => {
    if (hashes.has(sample.id)) return hashes.get(sample.id) ?? null;
    let hash: Uint8Array | null;
    try {
      hash = await options.perceptualHashProvider(sample, options.signal);
      throwIfAborted(options.signal);
      if (hash !== null && (!(hash instanceof Uint8Array) || hash.length === 0)) hash = null;
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw createAbortError();
      hash = null;
    }
    hashes.set(sample.id, hash);
    return hash;
  };

  const nearGroups: ProjectSample[][] = [];
  let activeGroup: ProjectSample[] | null = null;
  for (let index = 0; index < pairs.length; index += 1) {
    await checkpoint(index, options.signal);
    const [left, right] = pairs[index];
    const [leftHash, rightHash] = await Promise.all([hashFor(left), hashFor(right)]);
    const distance = leftHash && rightHash ? perceptualHashDistance(leftHash, rightHash) : null;
    if (distance !== null && distance <= options.nearDuplicateHammingDistance) {
      if (activeGroup?.at(-1)?.id === left.id) activeGroup.push(right);
      else {
        activeGroup = [left, right];
        nearGroups.push(activeGroup);
      }
    } else {
      activeGroup = null;
    }
  }

  const resolvedCount = [...candidateIds].reduce(
    (count, sampleId) => count + Number(hashes.get(sampleId) instanceof Uint8Array),
    0,
  );
  const analysis: NearDuplicateAnalysis = resolvedCount === 0
    ? "unavailable"
    : resolvedCount === candidateIds.size
      ? "complete"
      : "partial";
  const className = projectClass.name.trim() || "未命名类别";
  return {
    analysis,
    issues: nearGroups.map((group) => ({
      severity: "warning",
      code: "consecutive-camera-near-duplicate",
      message: `“${className}”中有 ${group.length} 张连续采集图片非常相似，建议只保留有明显变化的画面。`,
      classIds: [projectClass.id],
      sampleIds: group.map((sample) => sample.id),
    })),
  };
}

async function analyzeClassWithOptions(
  projectClass: ProjectClass,
  options: NormalizedOptions,
): Promise<ClassDataHealth> {
  throwIfAborted(options.signal);
  const className = projectClass.name.trim() || "未命名类别";
  const issues: DataHealthIssue[] = [];
  const sampleCount = projectClass.samples.length;
  if (sampleCount < options.minimumSamplesPerClass) {
    issues.push({
      severity: "error",
      code: "insufficient-samples",
      message: `“${className}”只有 ${sampleCount} 张图片，至少需要 ${options.minimumSamplesPerClass} 张才能训练。`,
      classIds: [projectClass.id],
      sampleIds: [],
    });
  } else if (sampleCount < options.recommendedSamplesPerClass) {
    issues.push({
      severity: "warning",
      code: "below-recommended-samples",
      message: `“${className}”有 ${sampleCount} 张图片，建议补充到 ${options.recommendedSamplesPerClass} 张以上。`,
      classIds: [projectClass.id],
      sampleIds: [],
    });
  }

  const references = projectClass.samples.map((sample) => ({ sample }));
  for (const group of await exactDuplicateGroups(references, options.signal)) {
    issues.push({
      severity: "warning",
      code: "exact-duplicate",
      message: `“${className}”中有 ${group.length} 张完全相同的图片。`,
      classIds: [projectClass.id],
      sampleIds: group.map((reference) => reference.sample.id),
    });
  }

  const nearDuplicates = await analyzeConsecutiveCameraSamples(projectClass, options);
  issues.push(...nearDuplicates.issues);
  throwIfAborted(options.signal);
  return {
    classId: projectClass.id,
    className,
    sampleCount,
    issues,
    nearDuplicateAnalysis: nearDuplicates.analysis,
  };
}

export async function analyzeClassDataHealth(
  projectClass: ProjectClass,
  options: DataHealthOptions = {},
): Promise<ClassDataHealth> {
  return analyzeClassWithOptions(projectClass, normalizeOptions(options));
}

function combinedNearDuplicateAnalysis(classes: readonly ClassDataHealth[]): NearDuplicateAnalysis {
  const relevant = classes
    .map((result) => result.nearDuplicateAnalysis)
    .filter((status) => status !== "not-needed");
  if (relevant.length === 0) return "not-needed";
  if (relevant.every((status) => status === "complete")) return "complete";
  if (relevant.every((status) => status === "unavailable")) return "unavailable";
  return "partial";
}

export async function analyzeProjectDataHealth(
  project: Project,
  options: DataHealthOptions = {},
): Promise<ProjectDataHealth> {
  const normalized = normalizeOptions(options);
  throwIfAborted(normalized.signal);
  const classes: ClassDataHealth[] = [];
  for (let index = 0; index < project.classes.length; index += 1) {
    await checkpoint(index, normalized.signal);
    classes.push(await analyzeClassWithOptions(project.classes[index], normalized));
  }

  const globalIssues: DataHealthIssue[] = [];
  if (project.classes.length >= 2) {
    const counts = project.classes.map((projectClass) => projectClass.samples.length);
    const minimum = Math.min(...counts);
    const maximum = Math.max(...counts);
    const imbalanced = maximum > 0 && (
      minimum === 0
        ? maximum >= normalized.minimumSamplesPerClass
        : maximum / minimum >= normalized.imbalanceRatio
    );
    if (imbalanced) {
      const relatedClassIds = project.classes
        .filter((projectClass) => {
          const count = projectClass.samples.length;
          return count === minimum || count === maximum;
        })
        .map((projectClass) => projectClass.id);
      globalIssues.push({
        severity: "warning",
        code: "class-imbalance",
        message: `类别样本数量差异较大（最少 ${minimum} 张，最多 ${maximum} 张），建议保持各类别数量接近。`,
        classIds: relatedClassIds,
        sampleIds: [],
      });
    }
  }

  const allSamples: SampleReference[] = project.classes.flatMap((projectClass) =>
    projectClass.samples.map((sample) => ({ classId: projectClass.id, sample })),
  );
  for (const group of await exactDuplicateGroups(allSamples, normalized.signal)) {
    const classIds = [...new Set(group.map((reference) => reference.classId))];
    if (classIds.length < 2) continue;
    globalIssues.push({
      severity: "error",
      code: "cross-class-exact-duplicate",
      message: `同一张图片出现在 ${classIds.length} 个类别中，可能造成标签冲突。`,
      classIds,
      sampleIds: group.map((reference) => reference.sample.id),
    });
  }

  throwIfAborted(normalized.signal);
  const classIssues = classes.flatMap((result) => result.issues);
  return {
    totalSamples: allSamples.length,
    globalIssues,
    classes,
    issues: [...globalIssues, ...classIssues],
    nearDuplicateAnalysis: combinedNearDuplicateAnalysis(classes),
  };
}
