import type { ClassifierModelBundle } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    typeof ArrayBuffer !== "undefined" &&
    (value instanceof ArrayBuffer ||
      Object.prototype.toString.call(value) === "[object ArrayBuffer]")
  );
}

export function normalizeClassifierLabels(labels: readonly string[]): string[] {
  const normalized = labels.map((label) => label.trim());
  if (
    normalized.length < 2 ||
    normalized.some((label) => !label) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error("A classifier requires at least two unique, non-empty labels.");
  }
  return normalized;
}

/** Validate an unknown value without importing or initializing TensorFlow.js. */
export function validateClassifierModelBundle(
  value: unknown,
): asserts value is ClassifierModelBundle {
  if (!isRecord(value)) {
    throw new TypeError("The classifier model bundle must be an object.");
  }
  if (
    value.format !== "teachable-image-classifier" ||
    value.version !== 1
  ) {
    throw new Error("Unsupported classifier model format or version.");
  }
  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error("The classifier model has an invalid creation date.");
  }
  if (
    !Array.isArray(value.labels) ||
    value.labels.some((label) => typeof label !== "string")
  ) {
    throw new Error("The classifier model has invalid class labels.");
  }
  normalizeClassifierLabels(value.labels);

  const extractor = value.featureExtractor;
  if (
    !isRecord(extractor) ||
    extractor.name !== "MobileNet" ||
    extractor.version !== 2 ||
    extractor.alpha !== 0.5 ||
    !Number.isInteger(extractor.embeddingSize) ||
    (extractor.embeddingSize as number) < 1
  ) {
    throw new Error("The classifier model has invalid feature extractor metadata.");
  }

  const artifacts = value.artifacts;
  if (
    !isRecord(artifacts) ||
    artifacts.modelTopology === undefined ||
    !Array.isArray(artifacts.weightSpecs)
  ) {
    throw new Error("The classifier model is missing TensorFlow.js artifacts.");
  }
  const weightData = artifacts.weightData;
  if (
    !isArrayBuffer(weightData) &&
    !(
      Array.isArray(weightData) &&
      weightData.length > 0 &&
      weightData.every(isArrayBuffer)
    )
  ) {
    throw new Error("The classifier model has invalid binary weight data.");
  }
}

export function isClassifierModelBundle(
  value: unknown,
): value is ClassifierModelBundle {
  try {
    validateClassifierModelBundle(value);
    return true;
  } catch {
    return false;
  }
}

export type ModelInputKind = "embedding" | "image" | "unsupported";

/**
 * Classify a TensorFlow input shape before choosing an import path. This
 * runtime consumes embedding heads; full image models need their own metadata
 * and preprocessing pipeline.
 */
export function detectModelInputKind(
  shape: readonly (number | null)[],
): ModelInputKind {
  if (
    shape.length === 2 &&
    Number.isInteger(shape[1]) &&
    (shape[1] as number) > 0
  ) {
    return "embedding";
  }
  if (
    shape.length === 4 &&
    shape[1] !== null &&
    shape[2] !== null &&
    shape[3] === 3
  ) {
    return "image";
  }
  return "unsupported";
}
