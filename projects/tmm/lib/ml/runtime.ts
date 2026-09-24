import {
  createAbortError,
  resolveImageInput,
  throwIfAborted,
  assertBrowser,
} from "./image";
import {
  detectModelInputKind,
  normalizeClassifierLabels,
  validateClassifierModelBundle,
} from "./model-bundle";
import type {
  ClassifierModelBundle,
  ClassifierState,
  ClassPrediction,
  ImageInput,
  PredictOptions,
  TrainOptions,
  TrainingExample,
  TrainingProgress,
  TrainingResult,
  TrainingValidationSplit,
  ValidationMetrics,
} from "./types";

type TensorFlow = typeof import("@tensorflow/tfjs");
type MobileNetPackage = typeof import("@tensorflow-models/mobilenet");
type MobileNet = Awaited<ReturnType<MobileNetPackage["load"]>>;
type LayersModel = import("@tensorflow/tfjs").LayersModel;
type Tensor = import("@tensorflow/tfjs").Tensor;
type ModelArtifacts = import("@tensorflow/tfjs").io.ModelArtifacts;

const DEFAULT_EPOCHS = 30;
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_LEARNING_RATE = 0.001;
const DEFAULT_HIDDEN_UNITS = 100;
const VALIDATION_SPLIT_SEED = 0x5eed1234;

let tensorflowPromise: Promise<TensorFlow> | null = null;
let mobileNetPackagePromise: Promise<MobileNetPackage> | null = null;

async function getTensorFlow(): Promise<TensorFlow> {
  assertBrowser();
  tensorflowPromise ??= import("@tensorflow/tfjs");
  const tf = await tensorflowPromise;
  await tf.ready();
  return tf;
}

async function getMobileNetPackage(): Promise<MobileNetPackage> {
  assertBrowser();
  mobileNetPackagePromise ??= import("@tensorflow-models/mobilenet");
  return mobileNetPackagePromise;
}

function finiteMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

function validateTrainingOptions(options: TrainOptions): Required<
  Pick<
    TrainOptions,
    | "epochs"
    | "batchSize"
    | "learningRate"
    | "hiddenUnits"
    | "validationSplit"
    | "shuffle"
  >
> {
  const epochs = positiveInteger(options.epochs ?? DEFAULT_EPOCHS, "epochs");
  const batchSize = positiveInteger(
    options.batchSize ?? DEFAULT_BATCH_SIZE,
    "batchSize",
  );
  const hiddenUnits = positiveInteger(
    options.hiddenUnits ?? DEFAULT_HIDDEN_UNITS,
    "hiddenUnits",
  );
  const learningRate = options.learningRate ?? DEFAULT_LEARNING_RATE;
  const validationSplit = options.validationSplit ?? 0;

  if (!Number.isFinite(learningRate) || learningRate <= 0) {
    throw new RangeError("learningRate must be greater than zero.");
  }
  if (
    !Number.isFinite(validationSplit) ||
    validationSplit < 0 ||
    validationSplit >= 1
  ) {
    throw new RangeError("validationSplit must be at least 0 and less than 1.");
  }

  return {
    epochs,
    batchSize,
    hiddenUnits,
    learningRate,
    validationSplit,
    shuffle: options.shuffle ?? true,
  };
}

function normalizeLabels(examples: readonly TrainingExample[]): string[] {
  if (examples.length < 2) {
    throw new Error("At least two training images are required.");
  }

  const labels: string[] = [];
  const seen = new Set<string>();

  for (const example of examples) {
    const label = example.label.trim();
    if (!label) {
      throw new Error("Every training image must have a non-empty label.");
    }
    if (!seen.has(label)) {
      labels.push(label);
      seen.add(label);
    }
  }

  if (labels.length < 2) {
    throw new Error("Training requires at least two different classes.");
  }

  return labels;
}

interface DatasetGroup {
  indexes: number[];
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffleInPlace<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
}

function normalizedGroupKey(example: TrainingExample, exampleIndex: number): string {
  if (example.groupId === undefined) return `sample:${exampleIndex}`;
  if (typeof example.groupId !== "string") {
    throw new TypeError("Training example groupId must be a string when provided.");
  }
  const groupId = example.groupId.trim();
  return groupId ? `group:${groupId}` : `sample:${exampleIndex}`;
}

function selectValidationGroups(
  groups: readonly DatasetGroup[],
  targetExampleCount: number,
  random: () => number,
): Set<DatasetGroup> {
  const candidates = [...groups];
  shuffleInPlace(candidates, random);
  candidates.sort((left, right) => left.indexes.length - right.indexes.length);

  const selected = new Set<DatasetGroup>();
  let selectedExampleCount = 0;
  for (const group of candidates) {
    if (selected.size >= groups.length - 1) break;
    const currentDistance = Math.abs(targetExampleCount - selectedExampleCount);
    const nextDistance = Math.abs(
      targetExampleCount - selectedExampleCount - group.indexes.length,
    );
    if (nextDistance < currentDistance) {
      selected.add(group);
      selectedExampleCount += group.indexes.length;
    }
  }

  // With two large groups, either group may exceed the requested fraction.
  // Holding out the smaller group is still safer than splitting a capture group.
  if (selected.size === 0) selected.add(candidates[0]);
  return selected;
}

/**
 * Deterministically split examples by class without dividing a capture group.
 * This is exported for pure diagnostics and unit testing; model training uses
 * the same plan directly.
 */
export function stratifiedGroupDatasetSplit(
  examples: readonly TrainingExample[],
  classIndexes: readonly number[],
  classCount: number,
  validationSplit: number,
): TrainingValidationSplit {
  if (examples.length !== classIndexes.length) {
    throw new RangeError("Training examples and class indexes must have the same length.");
  }
  if (!Number.isInteger(classCount) || classCount < 2) {
    throw new RangeError("Group-stratified validation requires at least two classes.");
  }
  if (
    !Number.isFinite(validationSplit) ||
    validationSplit < 0 ||
    validationSplit >= 1
  ) {
    throw new RangeError("validationSplit must be at least 0 and less than 1.");
  }
  classIndexes.forEach((classIndex, exampleIndex) => {
    if (!Number.isInteger(classIndex) || classIndex < 0 || classIndex >= classCount) {
      throw new RangeError(`Invalid class index at training example ${exampleIndex}.`);
    }
  });
  if (validationSplit <= 0) {
    return {
      trainingIndexes: classIndexes.map((_, index) => index),
      validationIndexes: [],
      validationStatus: "disabled",
    };
  }

  const groupsByClass = Array.from(
    { length: classCount },
    () => new Map<string, DatasetGroup>(),
  );
  classIndexes.forEach((classIndex, exampleIndex) => {
    const groups = groupsByClass[classIndex];
    const key = normalizedGroupKey(examples[exampleIndex], exampleIndex);
    const group = groups.get(key) ?? { indexes: [] };
    group.indexes.push(exampleIndex);
    groups.set(key, group);
  });

  // A class needs at least two independent groups: one to learn from and one
  // to evaluate. Partial-class validation would make aggregate metrics unsafe.
  if (groupsByClass.some((groups) => groups.size < 2)) {
    return {
      trainingIndexes: classIndexes.map((_, index) => index),
      validationIndexes: [],
      validationStatus: "insufficient-groups",
    };
  }

  const random = createSeededRandom(VALIDATION_SPLIT_SEED);
  const trainingIndexes: number[] = [];
  const validationIndexes: number[] = [];

  for (const groups of groupsByClass) {
    const classGroups = [...groups.values()];
    const classExampleCount = classGroups.reduce(
      (total, group) => total + group.indexes.length,
      0,
    );
    const validationGroups = selectValidationGroups(
      classGroups,
      Math.max(1, Math.ceil(classExampleCount * validationSplit)),
      random,
    );
    for (const group of classGroups) {
      (validationGroups.has(group) ? validationIndexes : trainingIndexes).push(
        ...group.indexes,
      );
    }
  }

  return {
    trainingIndexes,
    validationIndexes,
    validationStatus: "available",
  };
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Compute finite, label-aligned metrics from held-out class indexes. */
export function computeValidationMetrics(
  labels: readonly string[],
  actualClassIndexes: readonly number[],
  predictedClassIndexes: readonly number[],
): ValidationMetrics {
  const normalizedLabels = normalizeClassifierLabels(labels);
  if (actualClassIndexes.length < 1) {
    throw new RangeError("At least one validation prediction is required.");
  }
  if (actualClassIndexes.length !== predictedClassIndexes.length) {
    throw new RangeError("Actual and predicted validation indexes must have the same length.");
  }

  const classCount = normalizedLabels.length;
  const confusionMatrix = Array.from(
    { length: classCount },
    () => Array.from({ length: classCount }, () => 0),
  );
  actualClassIndexes.forEach((actualClassIndex, index) => {
    const predictedClassIndex = predictedClassIndexes[index];
    if (
      !Number.isInteger(actualClassIndex) ||
      actualClassIndex < 0 ||
      actualClassIndex >= classCount ||
      !Number.isInteger(predictedClassIndex) ||
      predictedClassIndex < 0 ||
      predictedClassIndex >= classCount
    ) {
      throw new RangeError(`Invalid validation class index at position ${index}.`);
    }
    confusionMatrix[actualClassIndex][predictedClassIndex] += 1;
  });

  const support = confusionMatrix.map((row) =>
    row.reduce((total, count) => total + count, 0),
  );
  const predictedTotals = Array.from({ length: classCount }, (_, classIndex) =>
    confusionMatrix.reduce((total, row) => total + row[classIndex], 0),
  );
  const perClass = normalizedLabels.map((label, classIndex) => {
    const truePositive = confusionMatrix[classIndex][classIndex];
    const precision = safeRatio(truePositive, predictedTotals[classIndex]);
    const recall = safeRatio(truePositive, support[classIndex]);
    return {
      label,
      support: support[classIndex],
      precision,
      recall,
      f1: safeRatio(2 * precision * recall, precision + recall),
    };
  });
  const correct = confusionMatrix.reduce(
    (total, row, classIndex) => total + row[classIndex],
    0,
  );

  return {
    exampleCount: actualClassIndexes.length,
    support,
    confusionMatrix,
    perClass,
    accuracy: correct / actualClassIndexes.length,
    macroF1: perClass.reduce((total, metrics) => total + metrics.f1, 0) / classCount,
    balancedAccuracy:
      perClass.reduce((total, metrics) => total + metrics.recall, 0) / classCount,
  };
}

function flattenSelectedVectors(
  vectors: readonly Float32Array[],
  indexes: readonly number[],
  embeddingSize: number,
): Float32Array {
  const flattened = new Float32Array(indexes.length * embeddingSize);
  indexes.forEach((sourceIndex, targetIndex) => {
    flattened.set(vectors[sourceIndex], targetIndex * embeddingSize);
  });
  return flattened;
}

function createOneHotTargets(
  tf: TensorFlow,
  classIndexes: readonly number[],
  classCount: number,
): Tensor {
  return tf.tidy(() => {
    const indexTensor = tf.tensor1d(Int32Array.from(classIndexes), "int32");
    return tf.oneHot(indexTensor, classCount);
  });
}

async function predictClassIndexes(
  model: LayersModel,
  inputs: Tensor,
  classCount: number,
  signal?: AbortSignal,
): Promise<number[]> {
  throwIfAborted(signal);
  let output: Tensor | null = null;
  try {
    const prediction = model.predict(inputs);
    if (Array.isArray(prediction)) {
      if (prediction.length !== 1) {
        prediction.forEach((tensor) => tensor.dispose());
        throw new Error("The classifier returned multiple validation outputs.");
      }
      output = prediction[0];
    } else {
      output = prediction;
    }

    const exampleCount = inputs.shape[0];
    if (
      output.rank !== 2 ||
      output.shape[0] !== exampleCount ||
      output.shape[1] !== classCount
    ) {
      throw new Error("The classifier validation output has an unexpected shape.");
    }
    const probabilities = await output.data();
    throwIfAborted(signal);

    const predictedClassIndexes: number[] = [];
    for (let exampleIndex = 0; exampleIndex < exampleCount; exampleIndex += 1) {
      let bestClassIndex = 0;
      let bestProbability = Number.NEGATIVE_INFINITY;
      for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        const probability = Number(probabilities[exampleIndex * classCount + classIndex]);
        if (!Number.isFinite(probability)) {
          throw new Error("The classifier produced a non-finite validation probability.");
        }
        if (probability > bestProbability) {
          bestProbability = probability;
          bestClassIndex = classIndex;
        }
      }
      predictedClassIndexes.push(bestClassIndex);
    }
    return predictedClassIndexes;
  } finally {
    output?.dispose();
  }
}

function emitProgress(
  callback: TrainOptions["onProgress"],
  progress: TrainingProgress,
): void {
  callback?.({
    ...progress,
    fraction: Math.max(0, Math.min(1, progress.fraction)),
  });
}

function cloneBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

function cloneArtifacts(artifacts: ModelArtifacts): ModelArtifacts {
  const weightData = artifacts.weightData;
  return {
    ...artifacts,
    weightSpecs: artifacts.weightSpecs?.map((spec) => ({ ...spec })),
    weightData: Array.isArray(weightData)
      ? weightData.map(cloneBuffer)
      : weightData instanceof ArrayBuffer
        ? cloneBuffer(weightData)
        : weightData,
  };
}

function disposeMobileNet(model: MobileNet | null): void {
  if (!model) return;

  const disposable = model as MobileNet & {
    dispose?: () => void;
    model?: { dispose: () => void };
  };
  if (typeof disposable.dispose === "function") {
    disposable.dispose();
  } else {
    disposable.model?.dispose();
  }
}

export class TeachableImageClassifier {
  private featureExtractor: MobileNet | null = null;
  private featureExtractorPromise: Promise<MobileNet> | null = null;
  private classifier: LayersModel | null = null;
  private labels: string[] = [];
  private embeddingSize: number | null = null;
  private training = false;
  private activeTrainingModel: LayersModel | null = null;
  private disposed = false;

  getState(): ClassifierState {
    return {
      featureExtractorReady: this.featureExtractor !== null,
      classifierReady: this.classifier !== null,
      training: this.training,
      disposed: this.disposed,
      labels: [...this.labels],
      embeddingSize: this.embeddingSize,
    };
  }

  getLabels(): string[] {
    return [...this.labels];
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error("This image classifier has been disposed.");
    }
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    throwIfAborted(signal);
    await this.ensureFeatureExtractor(signal);
    throwIfAborted(signal);
  }

  private async ensureFeatureExtractor(signal?: AbortSignal): Promise<MobileNet> {
    this.assertUsable();
    throwIfAborted(signal);

    if (this.featureExtractor) return this.featureExtractor;

    if (!this.featureExtractorPromise) {
      this.featureExtractorPromise = (async () => {
        const [, mobileNet] = await Promise.all([
          getTensorFlow(),
          getMobileNetPackage(),
        ]);
        return mobileNet.load({
          version: 2,
          alpha: 0.5,
          modelUrl: "/models/mobilenet-v2-050/model.json",
          inputRange: [0, 1],
        });
      })();
    }

    try {
      const extractor = await this.featureExtractorPromise;
      if (this.disposed) {
        disposeMobileNet(extractor);
        throw new Error("This image classifier has been disposed.");
      }
      this.featureExtractor = extractor;
      throwIfAborted(signal);
      return extractor;
    } catch (error) {
      this.featureExtractorPromise = null;
      throw error;
    }
  }

  async extractEmbedding(
    input: ImageInput,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    this.assertUsable();
    const [tf, extractor, image] = await Promise.all([
      getTensorFlow(),
      this.ensureFeatureExtractor(signal),
      resolveImageInput(input, signal),
    ]);
    throwIfAborted(signal);

    const embedding = tf.tidy(() => extractor.infer(image, true).flatten());
    try {
      const values = await embedding.data();
      throwIfAborted(signal);
      const result = Float32Array.from(values);

      if (this.embeddingSize !== null && this.embeddingSize !== result.length) {
        throw new Error(
          `Unexpected embedding size ${result.length}; expected ${this.embeddingSize}.`,
        );
      }
      return result;
    } finally {
      embedding.dispose();
    }
  }

  async train(
    examples: readonly TrainingExample[],
    options: TrainOptions = {},
  ): Promise<TrainingResult> {
    this.assertUsable();
    if (this.training) {
      throw new Error("A training operation is already in progress.");
    }

    const settings = validateTrainingOptions(options);
    const labels = normalizeLabels(examples);
    const labelIndexes = new Map(labels.map((label, index) => [label, index]));
    const startedAt = Date.now();
    let candidate: LayersModel | null = null;
    this.training = true;

    try {
      throwIfAborted(options.signal);
      emitProgress(options.onProgress, {
        phase: "loading",
        fraction: 0,
        completed: 0,
        total: 1,
      });
      const tf = await getTensorFlow();
      await this.ensureFeatureExtractor(options.signal);
      emitProgress(options.onProgress, {
        phase: "loading",
        fraction: 1,
        completed: 1,
        total: 1,
      });

      const vectors: Float32Array[] = [];
      for (let index = 0; index < examples.length; index += 1) {
        throwIfAborted(options.signal);
        vectors.push(
          await this.extractEmbedding(examples[index].image, options.signal),
        );
        emitProgress(options.onProgress, {
          phase: "extracting",
          fraction: (index + 1) / examples.length,
          completed: index + 1,
          total: examples.length,
        });
      }

      const embeddingSize = vectors[0]?.length;
      if (!embeddingSize || vectors.some((vector) => vector.length !== embeddingSize)) {
        throw new Error("Training images produced inconsistent embeddings.");
      }
      throwIfAborted(options.signal);

      const classIndexes = examples.map((example) => {
        const classIndex = labelIndexes.get(example.label.trim());
        if (classIndex === undefined) {
          throw new Error(`Unknown training label: ${example.label}`);
        }
        return classIndex;
      });
      const { trainingIndexes, validationIndexes, validationStatus } =
        stratifiedGroupDatasetSplit(
          examples,
          classIndexes,
          labels.length,
          settings.validationSplit,
        );
      const trainingClassIndexes = trainingIndexes.map((index) => classIndexes[index]);
      const validationClassIndexes = validationIndexes.map((index) => classIndexes[index]);
      const trainingVectors = flattenSelectedVectors(vectors, trainingIndexes, embeddingSize);
      const validationVectors = validationIndexes.length > 0
        ? flattenSelectedVectors(vectors, validationIndexes, embeddingSize)
        : null;

      candidate = tf.sequential({
        layers: [
          tf.layers.dense({
            inputShape: [embeddingSize],
            units: settings.hiddenUnits,
            activation: "relu",
            kernelInitializer: "varianceScaling",
          }),
          tf.layers.dropout({ rate: 0.2 }),
          tf.layers.dense({
            units: labels.length,
            activation: "softmax",
            kernelInitializer: "varianceScaling",
          }),
        ],
      });
      candidate.compile({
        optimizer: tf.train.adam(settings.learningRate),
        loss: "categoricalCrossentropy",
        metrics: ["accuracy"],
      });
      this.activeTrainingModel = candidate;

      let inputs: Tensor | null = null;
      let targets: Tensor | null = null;
      let validationInputs: Tensor | null = null;
      let validationTargets: Tensor | null = null;
      let epochsCompleted = 0;
      const onAbort = (): void => {
        if (candidate) candidate.stopTraining = true;
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        throwIfAborted(options.signal);
        inputs = tf.tensor2d(trainingVectors, [trainingIndexes.length, embeddingSize]);
        targets = createOneHotTargets(tf, trainingClassIndexes, labels.length);
        if (validationVectors) {
          validationInputs = tf.tensor2d(
            validationVectors,
            [validationIndexes.length, embeddingSize],
          );
          validationTargets = createOneHotTargets(
            tf,
            validationClassIndexes,
            labels.length,
          );
        }
        throwIfAborted(options.signal);

        const history = await candidate.fit(inputs, targets, {
          epochs: settings.epochs,
          batchSize: Math.min(settings.batchSize, trainingIndexes.length),
          validationData: validationInputs && validationTargets
            ? [validationInputs, validationTargets]
            : undefined,
          shuffle: settings.shuffle,
          callbacks: {
            onBatchEnd: async () => {
              if (options.signal?.aborted && candidate) {
                candidate.stopTraining = true;
              }
              await tf.nextFrame();
            },
            onEpochEnd: async (epoch, logs) => {
              epochsCompleted = epoch + 1;
              emitProgress(options.onProgress, {
                phase: "training",
                fraction: epochsCompleted / settings.epochs,
                completed: epochsCompleted,
                total: settings.epochs,
                epoch: epochsCompleted,
                loss: finiteMetric(logs?.loss),
                accuracy: finiteMetric(logs?.acc ?? logs?.accuracy),
                validationLoss: finiteMetric(logs?.val_loss),
                validationAccuracy: finiteMetric(
                  logs?.val_acc ?? logs?.val_accuracy,
                ),
              });
              await tf.nextFrame();
            },
          },
        });

        throwIfAborted(options.signal);
        const validation = validationInputs
          ? computeValidationMetrics(
              labels,
              validationClassIndexes,
              await predictClassIndexes(
                candidate,
                validationInputs,
                labels.length,
                options.signal,
              ),
            )
          : null;
        throwIfAborted(options.signal);
        this.assertUsable();
        this.classifier?.dispose();
        this.classifier = candidate;
        candidate = null;
        this.labels = [...labels];
        this.embeddingSize = embeddingSize;
        emitProgress(options.onProgress, {
          phase: "complete",
          fraction: 1,
          completed: settings.epochs,
          total: settings.epochs,
          epoch: epochsCompleted,
        });

        const numericHistory: Record<string, number[]> = {};
        for (const [key, values] of Object.entries(history.history)) {
          numericHistory[key] = values
            .map((value) => Number(value))
            .filter(Number.isFinite);
        }

        return {
          labels: [...labels],
          exampleCount: examples.length,
          epochsCompleted,
          durationMs: Date.now() - startedAt,
          history: numericHistory,
          validationStatus,
          validation,
        };
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
        inputs?.dispose();
        targets?.dispose();
        validationInputs?.dispose();
        validationTargets?.dispose();
        this.activeTrainingModel = null;
      }
    } catch (error) {
      candidate?.dispose();
      if (options.signal?.aborted) {
        throw createAbortError();
      }
      throw error;
    } finally {
      this.training = false;
    }
  }

  async predict(
    input: ImageInput,
    options: PredictOptions = {},
  ): Promise<ClassPrediction[]> {
    this.assertUsable();
    if (!this.classifier || this.labels.length === 0) {
      throw new Error("Train or import a classifier before making predictions.");
    }

    const tf = await getTensorFlow();
    const embedding = await this.extractEmbedding(input, options.signal);
    throwIfAborted(options.signal);
    const inputTensor = tf.tensor2d(embedding, [1, embedding.length]);
    let output: Tensor | null = null;

    try {
      const prediction = this.classifier.predict(inputTensor);
      if (Array.isArray(prediction)) {
        if (prediction.length !== 1) {
          prediction.forEach((tensor) => tensor.dispose());
          throw new Error("The classifier returned multiple outputs.");
        }
        output = prediction[0];
      } else {
        output = prediction;
      }
      const probabilities = await output.data();
      throwIfAborted(options.signal);
      if (probabilities.length !== this.labels.length) {
        throw new Error("Classifier output does not match its class labels.");
      }

      const ranked = this.labels
        .map((label, index) => ({
          label,
          probability: Number(probabilities[index]),
        }))
        .sort((left, right) => right.probability - left.probability);
      const topK = options.topK ?? ranked.length;
      if (!Number.isInteger(topK) || topK < 1) {
        throw new RangeError("topK must be a positive integer.");
      }
      return ranked.slice(0, Math.min(topK, ranked.length));
    } finally {
      output?.dispose();
      inputTensor.dispose();
    }
  }

  async exportModel(): Promise<ClassifierModelBundle> {
    this.assertUsable();
    if (!this.classifier || !this.embeddingSize || this.labels.length === 0) {
      throw new Error("There is no trained classifier to export.");
    }

    const tf = await getTensorFlow();
    let captured: ModelArtifacts | null = null;
    await this.classifier.save(
      tf.io.withSaveHandler(async (artifacts) => {
        captured = cloneArtifacts(artifacts);
        return {
          modelArtifactsInfo: tf.io.getModelArtifactsInfoForJSON(artifacts),
        };
      }),
    );

    if (!captured) {
      throw new Error("TensorFlow.js did not return model artifacts.");
    }

    return {
      format: "teachable-image-classifier",
      version: 1,
      createdAt: new Date().toISOString(),
      labels: [...this.labels],
      featureExtractor: {
        name: "MobileNet",
        version: 2,
        alpha: 0.5,
        embeddingSize: this.embeddingSize,
      },
      artifacts: captured,
    };
  }

  async importModel(bundle: ClassifierModelBundle): Promise<void> {
    this.assertUsable();
    if (this.training) {
      throw new Error("Wait for training to finish before importing a model.");
    }
    validateClassifierModelBundle(bundle);

    const tf = await getTensorFlow();
    const imported = await tf.loadLayersModel(
      tf.io.fromMemory(cloneArtifacts(bundle.artifacts)),
    );
    const importedInputSize = imported.inputs[0]?.shape.at(-1);
    const importedOutputSize = imported.outputs[0]?.shape.at(-1);
    if (
      importedInputSize !== bundle.featureExtractor.embeddingSize ||
      importedOutputSize !== bundle.labels.length
    ) {
      imported.dispose();
      throw new Error("The model shape does not match its metadata.");
    }
    try {
      this.useClassifierHead(imported, bundle.labels);
    } catch (error) {
      imported.dispose();
      throw error;
    }
  }

  /**
   * Take ownership of an already-loaded, rank-2 TensorFlow.js classifier head.
   * Full image models (`[batch, height, width, 3]`) are intentionally rejected
   * because they require model-specific image preprocessing and metadata.
   */
  useClassifierHead(model: LayersModel, labels: readonly string[]): void {
    this.assertUsable();
    if (this.training) {
      throw new Error("Wait for training to finish before replacing the model.");
    }
    const normalizedLabels = normalizeClassifierLabels(labels);
    if (model.inputs.length !== 1 || model.outputs.length !== 1) {
      throw new Error("A classifier head must have exactly one input and output.");
    }
    const inputShape = model.inputs[0].shape;
    if (detectModelInputKind(inputShape) !== "embedding") {
      throw new Error(
        "Expected an embedding classifier with shape [batch, features], not a full image model.",
      );
    }
    const embeddingSize = inputShape[1];
    const outputSize = model.outputs[0].shape.at(-1);
    if (embeddingSize === null || outputSize !== normalizedLabels.length) {
      throw new Error("The classifier shape does not match its class labels.");
    }

    if (this.classifier !== model) this.classifier?.dispose();
    this.classifier = model;
    this.labels = normalizedLabels;
    this.embeddingSize = embeddingSize;
  }

  resetClassifier(): void {
    this.assertUsable();
    if (this.training) {
      throw new Error("Cancel or finish training before resetting the classifier.");
    }
    this.classifier?.dispose();
    this.classifier = null;
    this.labels = [];
    this.embeddingSize = null;
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.training && this.activeTrainingModel) {
      this.activeTrainingModel.stopTraining = true;
    }
    this.classifier?.dispose();
    this.classifier = null;
    disposeMobileNet(this.featureExtractor);
    this.featureExtractor = null;
    this.featureExtractorPromise = null;
    this.labels = [];
    this.embeddingSize = null;
    this.disposed = true;
  }
}

export function createImageClassifier(): TeachableImageClassifier {
  return new TeachableImageClassifier();
}

export function createImageClassifierFromHead(
  model: LayersModel,
  labels: readonly string[],
): TeachableImageClassifier {
  const classifier = new TeachableImageClassifier();
  classifier.useClassifierHead(model, labels);
  return classifier;
}

export function resetClassifier(classifier: TeachableImageClassifier): void {
  classifier.resetClassifier();
}

export function disposeClassifier(classifier: TeachableImageClassifier): void {
  classifier.dispose();
}
