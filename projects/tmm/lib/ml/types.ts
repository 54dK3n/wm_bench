/** Images accepted by MobileNet in a browser. Strings must be image data URLs. */
export type ImageInput =
  | string
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | ImageData;

export interface TrainingExample {
  image: ImageInput;
  label: string;
  /**
   * Samples with the same non-empty group id and class stay on the same side
   * of the training/validation split. Missing ids make each sample its own group.
   */
  groupId?: string;
}

export type TrainingPhase =
  | "loading"
  | "extracting"
  | "training"
  | "complete";

export interface TrainingProgress {
  phase: TrainingPhase;
  /** A normalized value in the inclusive range 0..1. */
  fraction: number;
  completed: number;
  total: number;
  epoch?: number;
  loss?: number;
  accuracy?: number;
  validationLoss?: number;
  validationAccuracy?: number;
}

export interface TrainOptions {
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  hiddenUnits?: number;
  /** Deterministic per-class holdout fraction; every class keeps a training example. */
  validationSplit?: number;
  shuffle?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: TrainingProgress) => void;
}

export interface TrainingResult {
  labels: string[];
  exampleCount: number;
  epochsCompleted: number;
  durationMs: number;
  history: Record<string, number[]>;
  validationStatus: ValidationStatus;
  validation: ValidationMetrics | null;
}

export type ValidationStatus = "available" | "disabled" | "insufficient-groups";

export interface TrainingValidationSplit {
  trainingIndexes: number[];
  validationIndexes: number[];
  validationStatus: ValidationStatus;
}

export interface ClassValidationMetrics {
  label: string;
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ValidationMetrics {
  exampleCount: number;
  /** Number of held-out examples for each entry in `TrainingResult.labels`. */
  support: number[];
  /** Rows are actual classes and columns are predicted classes. */
  confusionMatrix: number[][];
  perClass: ClassValidationMetrics[];
  accuracy: number;
  macroF1: number;
  balancedAccuracy: number;
}

export interface PredictOptions {
  /** Defaults to every class. */
  topK?: number;
  signal?: AbortSignal;
}

export interface ClassPrediction {
  label: string;
  probability: number;
}

export interface FeatureExtractorInfo {
  name: "MobileNet";
  version: 2;
  alpha: 0.5;
  embeddingSize: number;
}

/**
 * A structured-clone-friendly classifier export. `artifacts.weightData`
 * contains binary data, so packaging code should not JSON.stringify it as-is.
 */
export interface ClassifierModelBundle {
  format: "teachable-image-classifier";
  version: 1;
  createdAt: string;
  labels: string[];
  featureExtractor: FeatureExtractorInfo;
  artifacts: import("@tensorflow/tfjs").io.ModelArtifacts;
}

export interface ClassifierState {
  featureExtractorReady: boolean;
  classifierReady: boolean;
  training: boolean;
  disposed: boolean;
  labels: string[];
  embeddingSize: number | null;
}
