import type { Project } from "./types";
import { PROJECT_LIMITS, validateProject } from "./validation";

export const PROJECT_DATABASE_NAME = "tm-object-studio";
export const PROJECT_DATABASE_VERSION = 3;
export const CURRENT_PROJECT_KEY = "current-project";
export const CLASSIFIER_MODEL_STORE_NAME = "models";
export const PROJECT_STORE_NAME = "projects";
export const PROJECT_CATALOG_STORE_NAME = "project-catalog";
export const PROJECT_SETTINGS_STORE_NAME = "project-settings";
export const LAST_OPENED_PROJECT_ID_KEY = "last-opened-project-id";
export const DELETED_PROJECT_TOMBSTONE_KEY_PREFIX = "deleted-project:";
export const PROJECT_RECORD_KEY_PREFIX = "project:";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface StoredProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  classCount: number;
  sampleCount: number;
  hasModel: boolean;
}

type StoredProjectCatalogEntry = Omit<StoredProjectSummary, "hasModel">;

export interface SaveStoredProjectOptions {
  /** Defaults to true for backwards compatibility and explicit project opens. */
  makeLastOpened?: boolean;
  /**
   * Optimistic concurrency guard. Null requires a new project; a string must
   * exactly match the stored project's updatedAt. Omit for legacy overwrite behavior.
   */
  expectedUpdatedAt?: string | null;
}

export class ProjectStorageConflictError extends Error {
  constructor() {
    super("项目已在其他标签页更新，请重新载入后再保存");
    this.name = "ProjectStorageConflictError";
  }
}

function requireIndexedDb(): IDBFactory {
  if (typeof indexedDB === "undefined") {
    throw new Error("当前浏览器不支持 IndexedDB");
  }
  return indexedDB;
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new TypeError("项目 ID 无效");
  }
}

function projectRecordKey(projectId: string): string {
  return `${PROJECT_RECORD_KEY_PREFIX}${projectId}`;
}

function deletedProjectTombstoneKey(projectId: string): string {
  return `${DELETED_PROJECT_TOMBSTONE_KEY_PREFIX}${projectId}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务已中止"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败"));
  });
}

function createStoredProjectSummary(project: Project): StoredProjectCatalogEntry {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    classCount: project.classes.length,
    sampleCount: project.classes.reduce(
      (total, projectClass) => total + projectClass.samples.length,
      0,
    ),
  };
}

function isStoredProjectSummary(value: unknown): value is StoredProjectCatalogEntry {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Partial<StoredProjectCatalogEntry>;
  return (
    typeof summary.id === "string" &&
    PROJECT_ID_PATTERN.test(summary.id) &&
    typeof summary.name === "string" &&
    summary.name.length <= PROJECT_LIMITS.maxProjectNameLength &&
    typeof summary.createdAt === "string" &&
    Number.isFinite(Date.parse(summary.createdAt)) &&
    typeof summary.updatedAt === "string" &&
    Number.isFinite(Date.parse(summary.updatedAt)) &&
    Number.isInteger(summary.classCount) &&
    (summary.classCount ?? -1) >= 0 &&
    (summary.classCount ?? Number.POSITIVE_INFINITY) <= PROJECT_LIMITS.maxClassCount &&
    Number.isInteger(summary.sampleCount) &&
    (summary.sampleCount ?? -1) >= 0 &&
    (summary.sampleCount ?? Number.POSITIVE_INFINITY) <= PROJECT_LIMITS.maxTotalSamples
  );
}

function migrateLegacyCurrentProject(
  transaction: IDBTransaction,
  projectStore: IDBObjectStore,
  catalogStore: IDBObjectStore,
  settingsStore: IDBObjectStore,
): void {
  const legacyRequest = projectStore.get(CURRENT_PROJECT_KEY);
  legacyRequest.onsuccess = () => {
    const legacyProject: unknown = legacyRequest.result;
    if (legacyProject === undefined) return;

    try {
      validateProject(legacyProject);
    } catch {
      // Keep unreadable legacy data in place rather than deleting user data.
      return;
    }

    projectStore.put(legacyProject, projectRecordKey(legacyProject.id));
    catalogStore.put(createStoredProjectSummary(legacyProject), legacyProject.id);
    settingsStore.put(legacyProject.id, LAST_OPENED_PROJECT_ID_KEY);
    projectStore.delete(CURRENT_PROJECT_KEY);
  };
  legacyRequest.onerror = () => transaction.abort();
}

/** Shared opener for browser-local project and classifier-model storage. */
export function openProjectDatabase(): Promise<IDBDatabase> {
  const factory = requireIndexedDb();
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = factory.open(PROJECT_DATABASE_NAME, PROJECT_DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      if (!transaction) {
        reject(new Error("项目数据库升级事务不可用"));
        return;
      }

      const projectStore = database.objectStoreNames.contains(PROJECT_STORE_NAME)
        ? transaction.objectStore(PROJECT_STORE_NAME)
        : database.createObjectStore(PROJECT_STORE_NAME);
      if (!database.objectStoreNames.contains(CLASSIFIER_MODEL_STORE_NAME)) {
        database.createObjectStore(CLASSIFIER_MODEL_STORE_NAME);
      }
      const catalogStore = database.objectStoreNames.contains(PROJECT_CATALOG_STORE_NAME)
        ? transaction.objectStore(PROJECT_CATALOG_STORE_NAME)
        : database.createObjectStore(PROJECT_CATALOG_STORE_NAME);
      const settingsStore = database.objectStoreNames.contains(PROJECT_SETTINGS_STORE_NAME)
        ? transaction.objectStore(PROJECT_SETTINGS_STORE_NAME)
        : database.createObjectStore(PROJECT_SETTINGS_STORE_NAME);

      if (event.oldVersion < PROJECT_DATABASE_VERSION) {
        migrateLegacyCurrentProject(
          transaction,
          projectStore,
          catalogStore,
          settingsStore,
        );
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("无法打开项目数据库"));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("项目数据库升级被其他页面阻止，请关闭其他标签页后重试"));
    };
  });
}

export function isProjectStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/** List lightweight project metadata, newest update first. */
export async function listStoredProjects(): Promise<StoredProjectSummary[]> {
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(
      [PROJECT_CATALOG_STORE_NAME, CLASSIFIER_MODEL_STORE_NAME],
      "readonly",
    );
    const completion = transactionComplete(transaction);
    const [stored, modelKeys] = await Promise.all([
      requestResult<unknown[]>(transaction.objectStore(PROJECT_CATALOG_STORE_NAME).getAll()),
      requestResult<IDBValidKey[]>(transaction.objectStore(CLASSIFIER_MODEL_STORE_NAME).getAllKeys()),
    ]);
    await completion;
    const modelProjectIds = new Set(modelKeys.filter((key): key is string => typeof key === "string"));
    return stored
      .filter(isStoredProjectSummary)
      .map((summary) => ({ ...summary, hasModel: modelProjectIds.has(summary.id) }))
      .sort((left, right) => {
        const updatedDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
        return updatedDifference || left.id.localeCompare(right.id);
      });
  } finally {
    database.close();
  }
}

/** Load one project without changing the last-opened pointer. */
export async function loadStoredProjectById(projectId: string): Promise<Project | null> {
  assertProjectId(projectId);
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(PROJECT_STORE_NAME, "readonly");
    const completion = transactionComplete(transaction);
    const stored = await requestResult<unknown>(
      transaction.objectStore(PROJECT_STORE_NAME).get(projectRecordKey(projectId)),
    );
    await completion;
    if (stored === undefined) return null;
    validateProject(stored);
    return stored;
  } finally {
    database.close();
  }
}

/** Save a project and make it the last-opened project in one transaction. */
export async function saveStoredProject(
  project: Project,
  options: SaveStoredProjectOptions = {},
): Promise<void> {
  validateProject(project);
  const makeLastOpened = options.makeLastOpened ?? true;
  const expectedUpdatedAt = options.expectedUpdatedAt;
  if (
    expectedUpdatedAt !== undefined &&
    expectedUpdatedAt !== null &&
    typeof expectedUpdatedAt !== "string"
  ) {
    throw new TypeError("expectedUpdatedAt 必须是字符串、null 或未提供");
  }
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(
      [PROJECT_STORE_NAME, PROJECT_CATALOG_STORE_NAME, PROJECT_SETTINGS_STORE_NAME],
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    const projectStore = transaction.objectStore(PROJECT_STORE_NAME);
    const catalogStore = transaction.objectStore(PROJECT_CATALOG_STORE_NAME);
    const settingsStore = transaction.objectStore(PROJECT_SETTINGS_STORE_NAME);
    let deletedProject = false;
    let concurrentUpdate = false;
    const writeProject = () => {
      projectStore.put(project, projectRecordKey(project.id));
      catalogStore.put(createStoredProjectSummary(project), project.id);
      if (makeLastOpened) {
        settingsStore.put(project.id, LAST_OPENED_PROJECT_ID_KEY);
      }
    };
    const tombstoneRequest = settingsStore.get(deletedProjectTombstoneKey(project.id));
    tombstoneRequest.onsuccess = () => {
      if (tombstoneRequest.result !== undefined) {
        deletedProject = true;
        transaction.abort();
        return;
      }

      const existingProjectRequest = projectStore.get(projectRecordKey(project.id));
      existingProjectRequest.onsuccess = () => {
        const existingProject: unknown = existingProjectRequest.result;
        const currentUpdatedAt =
          typeof existingProject === "object" &&
          existingProject !== null &&
          "updatedAt" in existingProject &&
          typeof existingProject.updatedAt === "string"
            ? existingProject.updatedAt
            : null;
        const expectationMatches =
          expectedUpdatedAt === undefined ||
          (expectedUpdatedAt === null
            ? existingProject === undefined
            : existingProject !== undefined && currentUpdatedAt === expectedUpdatedAt);
        if (!expectationMatches) {
          concurrentUpdate = true;
          transaction.abort();
          return;
        }
        writeProject();
      };
      existingProjectRequest.onerror = () => transaction.abort();
    };
    tombstoneRequest.onerror = () => transaction.abort();
    try {
      await completion;
    } catch (error) {
      if (deletedProject) {
        throw new Error("项目已被删除，无法再次保存旧项目数据");
      }
      if (concurrentUpdate) {
        throw new ProjectStorageConflictError();
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function getLastOpenedProjectId(): Promise<string | null> {
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(PROJECT_SETTINGS_STORE_NAME, "readonly");
    const completion = transactionComplete(transaction);
    const stored = await requestResult<unknown>(
      transaction.objectStore(PROJECT_SETTINGS_STORE_NAME).get(LAST_OPENED_PROJECT_ID_KEY),
    );
    await completion;
    return typeof stored === "string" && PROJECT_ID_PATTERN.test(stored) ? stored : null;
  } finally {
    database.close();
  }
}

/** Set the last-opened pointer. Passing null clears it. */
export async function setLastOpenedProjectId(projectId: string | null): Promise<void> {
  if (projectId !== null) assertProjectId(projectId);
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(PROJECT_SETTINGS_STORE_NAME, "readwrite");
    const completion = transactionComplete(transaction);
    const settingsStore = transaction.objectStore(PROJECT_SETTINGS_STORE_NAME);
    if (projectId === null) {
      settingsStore.delete(LAST_OPENED_PROJECT_ID_KEY);
    } else {
      settingsStore.put(projectId, LAST_OPENED_PROJECT_ID_KEY);
    }
    await completion;
  } finally {
    database.close();
  }
}

/** Delete project data and catalog metadata, but deliberately retain any saved model. */
export async function deleteStoredProject(projectId: string): Promise<void> {
  assertProjectId(projectId);
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(
      [PROJECT_STORE_NAME, PROJECT_CATALOG_STORE_NAME, PROJECT_SETTINGS_STORE_NAME],
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    transaction.objectStore(PROJECT_STORE_NAME).delete(projectRecordKey(projectId));
    transaction.objectStore(PROJECT_CATALOG_STORE_NAME).delete(projectId);

    const settingsStore = transaction.objectStore(PROJECT_SETTINGS_STORE_NAME);
    settingsStore.put(
      { deletedAt: new Date().toISOString() },
      deletedProjectTombstoneKey(projectId),
    );
    const lastOpenedRequest = settingsStore.get(LAST_OPENED_PROJECT_ID_KEY);
    lastOpenedRequest.onsuccess = () => {
      if (lastOpenedRequest.result === projectId) {
        settingsStore.delete(LAST_OPENED_PROJECT_ID_KEY);
      }
    };
    lastOpenedRequest.onerror = () => transaction.abort();
    await completion;
  } finally {
    database.close();
  }
}

/** Atomically delete a project, its catalog row, last-opened pointer, and saved model. */
export async function deleteStoredProjectAndModel(projectId: string): Promise<void> {
  assertProjectId(projectId);
  const database = await openProjectDatabase();
  try {
    const transaction = database.transaction(
      [
        PROJECT_STORE_NAME,
        PROJECT_CATALOG_STORE_NAME,
        PROJECT_SETTINGS_STORE_NAME,
        CLASSIFIER_MODEL_STORE_NAME,
      ],
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    transaction.objectStore(PROJECT_STORE_NAME).delete(projectRecordKey(projectId));
    transaction.objectStore(PROJECT_CATALOG_STORE_NAME).delete(projectId);
    transaction.objectStore(CLASSIFIER_MODEL_STORE_NAME).delete(projectId);

    const settingsStore = transaction.objectStore(PROJECT_SETTINGS_STORE_NAME);
    settingsStore.put(
      { deletedAt: new Date().toISOString() },
      deletedProjectTombstoneKey(projectId),
    );
    const lastOpenedRequest = settingsStore.get(LAST_OPENED_PROJECT_ID_KEY);
    lastOpenedRequest.onsuccess = () => {
      if (lastOpenedRequest.result === projectId) {
        settingsStore.delete(LAST_OPENED_PROJECT_ID_KEY);
      }
    };
    lastOpenedRequest.onerror = () => transaction.abort();
    await completion;
  } finally {
    database.close();
  }
}

/** Load an explicit project, or the last-opened project when no ID is supplied. */
export async function loadStoredProject(projectId?: string): Promise<Project | null> {
  const selectedProjectId = projectId ?? await getLastOpenedProjectId();
  return selectedProjectId === null ? null : loadStoredProjectById(selectedProjectId);
}

/** Compatibility wrappers for the former single current-project slot. */
export const saveCurrentProject = saveStoredProject;
export const loadCurrentProject = loadStoredProject;

export async function clearCurrentProject(): Promise<void> {
  const projectId = await getLastOpenedProjectId();
  if (projectId !== null) {
    await deleteStoredProject(projectId);
  }
}

export const clearStoredProject = clearCurrentProject;
