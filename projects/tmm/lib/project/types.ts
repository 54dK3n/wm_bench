export const PROJECT_FORMAT = "tm-object-project" as const;
export const PROJECT_FORMAT_VERSION = 1 as const;

export const MODEL_PACKAGE_FORMAT = "tm-object-classifier" as const;
export const MODEL_PACKAGE_VERSION = 1 as const;

export const SUPPORTED_IMAGE_SIZES = [224, 256] as const;
export type SupportedImageSize = (typeof SUPPORTED_IMAGE_SIZES)[number];

export type ProjectSampleSource = "upload" | "camera" | "import";

export interface ProjectSample {
  id: string;
  name: string;
  dataUrl: string;
  source: ProjectSampleSource;
  createdAt: string;
  width: SupportedImageSize;
  height: SupportedImageSize;
  /** Frames from the same guided camera burst stay together during validation. */
  captureGroupId?: string;
}

export interface ProjectClass {
  id: string;
  name: string;
  color: string;
  samples: ProjectSample[];
}

export interface TrainingSettings {
  epochs: number;
  batchSize: number;
  learningRate: number;
}

export interface PredictionSettings {
  confidenceThreshold: number;
  marginThreshold: number;
}

export interface Project {
  format: typeof PROJECT_FORMAT;
  formatVersion: typeof PROJECT_FORMAT_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  classes: ProjectClass[];
  training: TrainingSettings;
  /** Optional for backwards compatibility with version-1 project backups. */
  prediction?: PredictionSettings;
}

export interface ClassifierLabel {
  id: string;
  name: string;
  color: string;
}

export interface ClassifierModelMetadata {
  format: typeof MODEL_PACKAGE_FORMAT;
  formatVersion: typeof MODEL_PACKAGE_VERSION;
  name: string;
  createdAt: string;
  imageSize: SupportedImageSize;
  labels: ClassifierLabel[];
  training?: TrainingSettings;
  featureExtractor?: string;
  prediction?: PredictionSettings;
}

export const DEFAULT_TRAINING_SETTINGS: Readonly<TrainingSettings> = {
  epochs: 20,
  batchSize: 16,
  learningRate: 0.001,
};

export const DEFAULT_PREDICTION_SETTINGS: Readonly<PredictionSettings> = {
  confidenceThreshold: 0.65,
  marginThreshold: 0.12,
};

function makeId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return `${prefix}-${randomId}`;
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createProject(
  name = "未命名项目",
  classes: ProjectClass[] = [],
): Project {
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    id: makeId("project"),
    name,
    createdAt: now,
    updatedAt: now,
    classes,
    training: { ...DEFAULT_TRAINING_SETTINGS },
    prediction: { ...DEFAULT_PREDICTION_SETTINGS },
  };
}

export function createProjectClass(name: string, color: string): ProjectClass {
  return {
    id: makeId("class"),
    name,
    color,
    samples: [],
  };
}

export interface CreateProjectSampleInput {
  name: string;
  dataUrl: string;
  source?: ProjectSampleSource;
  size?: SupportedImageSize;
  captureGroupId?: string;
}

export function createProjectSample({
  name,
  dataUrl,
  source = "upload",
  size = 224,
  captureGroupId,
}: CreateProjectSampleInput): ProjectSample {
  return {
    id: makeId("sample"),
    name,
    dataUrl,
    source,
    createdAt: new Date().toISOString(),
    width: size,
    height: size,
    ...(captureGroupId ? { captureGroupId } : {}),
  };
}

export function createClassifierMetadata(
  project: Project,
  imageSize: SupportedImageSize = 224,
): ClassifierModelMetadata {
  return {
    format: MODEL_PACKAGE_FORMAT,
    formatVersion: MODEL_PACKAGE_VERSION,
    name: project.name.trim() || "未命名模型",
    createdAt: new Date().toISOString(),
    imageSize,
    labels: project.classes.map(({ id, name, color }) => ({ id, name: name.trim(), color })),
    training: { ...project.training },
    prediction: { ...(project.prediction ?? DEFAULT_PREDICTION_SETTINGS) },
  };
}
