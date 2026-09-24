import {
  CLASSIFIER_MODEL_STORE_NAME,
  DELETED_PROJECT_TOMBSTONE_KEY_PREFIX,
  openProjectDatabase,
  PROJECT_RECORD_KEY_PREFIX,
  PROJECT_SETTINGS_STORE_NAME,
  PROJECT_STORE_NAME,
} from "../project/storage";
import type { Project } from "../project/types";
import { validateClassifierModelBundle } from "./model-bundle";
import type { ClassifierModelBundle } from "./types";

export const PROJECT_DATASET_SIGNATURE_VERSION = 2;
export type ProjectDatasetSignatureVersion = 1 | 2;

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATASET_SIGNATURE_PATTERN = /^dataset-v(?:1|2):sha256:[0-9a-f]{64}$/;
const textEncoder = new TextEncoder();

export interface StoredClassifierModel {
  bundle: ClassifierModelBundle;
  datasetSignature: string;
  savedAt: string;
}

export interface SaveProjectClassifierModelOptions {
  /** Reject the model write if the persisted project changed during training. */
  expectedProjectUpdatedAt?: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB model request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB model transaction was aborted."),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error("IndexedDB model transaction failed."),
    );
  });
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new TypeError("Expected a valid project id.");
  }
}

function assertDatasetSignature(datasetSignature: string): void {
  if (!DATASET_SIGNATURE_PATTERN.test(datasetSignature)) {
    throw new TypeError("Expected a valid project dataset signature.");
  }
}

function deletedProjectTombstoneKey(projectId: string): string {
  return `${DELETED_PROJECT_TOMBSTONE_KEY_PREFIX}${projectId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validateStoredClassifierModel(value: unknown): asserts value is StoredClassifierModel {
  if (!isRecord(value)) {
    throw new TypeError("Stored classifier model must be an object.");
  }
  if (typeof value.datasetSignature !== "string") {
    throw new TypeError("Stored classifier model is missing its dataset signature.");
  }
  assertDatasetSignature(value.datasetSignature);
  if (!isValidIsoDate(value.savedAt)) {
    throw new TypeError("Stored classifier model has an invalid save date.");
  }
  validateClassifierModelBundle(value.bundle);
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto is required to create a project dataset signature.");
  }
  const digest = await subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareSamples(
  left: Project["classes"][number]["samples"][number],
  right: Project["classes"][number]["samples"][number],
): number {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return 0;
}

/**
 * Create a deterministic dataset signature using a specific canonical format.
 * Presentation and training settings are excluded. Version 1 intentionally
 * matches the original pre-capture-group format byte for byte.
 */
export async function createProjectDatasetSignatureForVersion(
  project: Project,
  version: ProjectDatasetSignatureVersion,
): Promise<string> {
  if (version !== 1 && version !== 2) {
    throw new RangeError("Project dataset signature version must be 1 or 2.");
  }

  const classes: Array<{
    id: string;
    name: string;
    samples: Array<{
      id: string;
      createdAt: string;
      captureGroupId?: string | null;
      contentDigest: string;
    }>;
  }> = [];

  for (const projectClass of project.classes) {
    const samples = [];
    for (const sample of [...projectClass.samples].sort(compareSamples)) {
      const contentDigest = await sha256(sample.dataUrl);
      samples.push(
        version === 1
          ? {
              id: sample.id,
              createdAt: sample.createdAt,
              contentDigest,
            }
          : {
              id: sample.id,
              createdAt: sample.createdAt,
              captureGroupId: sample.captureGroupId ?? null,
              contentDigest,
            },
      );
    }
    classes.push({
      id: projectClass.id,
      name: projectClass.name.trim(),
      samples,
    });
  }

  const canonicalDataset = JSON.stringify({
    version,
    classes,
  });
  return `dataset-v${version}:sha256:${await sha256(canonicalDataset)}`;
}

/** Create a signature using the current canonical dataset format. */
export function createProjectDatasetSignature(project: Project): Promise<string> {
  return createProjectDatasetSignatureForVersion(
    project,
    PROJECT_DATASET_SIGNATURE_VERSION,
  );
}

export function isClassifierModelStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function saveProjectClassifierModel(
  projectId: string,
  bundle: ClassifierModelBundle,
  datasetSignature: string,
  options: SaveProjectClassifierModelOptions = {},
): Promise<StoredClassifierModel> {
  assertProjectId(projectId);
  assertDatasetSignature(datasetSignature);
  validateClassifierModelBundle(bundle);
  if (
    options.expectedProjectUpdatedAt !== undefined &&
    !isValidIsoDate(options.expectedProjectUpdatedAt)
  ) {
    throw new TypeError("Expected a valid project update date.");
  }

  const storedModel: StoredClassifierModel = {
    bundle,
    datasetSignature,
    savedAt: new Date().toISOString(),
  };
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(
      [CLASSIFIER_MODEL_STORE_NAME, PROJECT_SETTINGS_STORE_NAME, PROJECT_STORE_NAME],
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    const modelStore = transaction.objectStore(CLASSIFIER_MODEL_STORE_NAME);
    const tombstoneRequest = transaction
      .objectStore(PROJECT_SETTINGS_STORE_NAME)
      .get(deletedProjectTombstoneKey(projectId));
    let deletedProject = false;
    let changedProject = false;
    const writeModel = () => modelStore.put(storedModel, projectId);
    tombstoneRequest.onsuccess = () => {
      if (tombstoneRequest.result !== undefined) {
        deletedProject = true;
        transaction.abort();
        return;
      }
      if (options.expectedProjectUpdatedAt === undefined) {
        writeModel();
        return;
      }
      const projectRequest = transaction
        .objectStore(PROJECT_STORE_NAME)
        .get(`${PROJECT_RECORD_KEY_PREFIX}${projectId}`);
      projectRequest.onsuccess = () => {
        const project: unknown = projectRequest.result;
        if (
          !isRecord(project) ||
          project.updatedAt !== options.expectedProjectUpdatedAt
        ) {
          changedProject = true;
          transaction.abort();
          return;
        }
        writeModel();
      };
      projectRequest.onerror = () => transaction.abort();
    };
    tombstoneRequest.onerror = () => transaction.abort();
    try {
      await completion;
    } catch (error) {
      if (deletedProject) {
        throw new Error("Project has been deleted; its classifier model cannot be saved.");
      }
      if (changedProject) {
        throw new Error("Project changed during training; its classifier model was not saved.");
      }
      throw error;
    }
    return storedModel;
  } finally {
    database.close();
  }
}

/**
 * Atomically update only the dataset signature of an unchanged stored model.
 * Returns false when the project was deleted, the record no longer exists, or
 * another writer replaced it after the caller read it.
 */
export async function upgradeProjectClassifierModelDatasetSignature(
  projectId: string,
  expectedDatasetSignature: string,
  expectedSavedAt: string,
  newDatasetSignature: string,
): Promise<boolean> {
  assertProjectId(projectId);
  assertDatasetSignature(expectedDatasetSignature);
  assertDatasetSignature(newDatasetSignature);
  if (!isValidIsoDate(expectedSavedAt)) {
    throw new TypeError("Expected a valid saved model date.");
  }

  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(
      [CLASSIFIER_MODEL_STORE_NAME, PROJECT_SETTINGS_STORE_NAME],
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    const modelStore = transaction.objectStore(CLASSIFIER_MODEL_STORE_NAME);
    const tombstoneRequest = transaction
      .objectStore(PROJECT_SETTINGS_STORE_NAME)
      .get(deletedProjectTombstoneKey(projectId));
    let upgraded = false;

    tombstoneRequest.onsuccess = () => {
      if (tombstoneRequest.result !== undefined) return;
      const modelRequest = modelStore.get(projectId);
      modelRequest.onsuccess = () => {
        const stored = modelRequest.result;
        if (
          !isRecord(stored) ||
          stored.datasetSignature !== expectedDatasetSignature ||
          stored.savedAt !== expectedSavedAt
        ) return;
        modelStore.put(
          { ...stored, datasetSignature: newDatasetSignature },
          projectId,
        );
        upgraded = true;
      };
      modelRequest.onerror = () => transaction.abort();
    };
    tombstoneRequest.onerror = () => transaction.abort();

    await completion;
    return upgraded;
  } finally {
    database.close();
  }
}

export async function loadProjectClassifierModel(
  projectId: string,
): Promise<StoredClassifierModel | null> {
  assertProjectId(projectId);
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(CLASSIFIER_MODEL_STORE_NAME, "readonly");
    const completion = transactionComplete(transaction);
    const store = transaction.objectStore(CLASSIFIER_MODEL_STORE_NAME);
    const [stored] = await Promise.all([
      requestResult<unknown>(store.get(projectId)),
      completion,
    ]);
    if (stored === undefined) {
      return null;
    }

    try {
      validateStoredClassifierModel(stored);
    } catch {
      const deleteTransaction = database.transaction(CLASSIFIER_MODEL_STORE_NAME, "readwrite");
      const deleteCompletion = transactionComplete(deleteTransaction);
      deleteTransaction.objectStore(CLASSIFIER_MODEL_STORE_NAME).delete(projectId);
      await deleteCompletion;
      return null;
    }

    return stored;
  } finally {
    database.close();
  }
}

export async function deleteProjectClassifierModel(projectId: string): Promise<void> {
  assertProjectId(projectId);
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(CLASSIFIER_MODEL_STORE_NAME, "readwrite");
    const completion = transactionComplete(transaction);
    transaction.objectStore(CLASSIFIER_MODEL_STORE_NAME).delete(projectId);
    await completion;
  } finally {
    database.close();
  }
}
