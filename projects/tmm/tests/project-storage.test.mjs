import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
let viteServer;
let storageModule;
let modelStorageModule;

async function getStorageModule() {
  storageModule ??= (async () => {
    const { createServer } = await import("vite");
    viteServer = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: projectRoot,
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
    });
    return viteServer.ssrLoadModule("/lib/project/storage.ts");
  })();
  return storageModule;
}

async function getModelStorageModule() {
  await getStorageModule();
  modelStorageModule ??= viteServer.ssrLoadModule("/lib/ml/model-storage.ts");
  return modelStorageModule;
}

after(async () => {
  await viteServer?.close();
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MemoryRequest {
  result = undefined;
  error = null;
  transaction = null;
  onsuccess = null;
  onerror = null;
  onupgradeneeded = null;
  onblocked = null;
}

class MemoryTransaction {
  error = null;
  oncomplete = null;
  onabort = null;
  onerror = null;

  #database;
  #pending = 0;
  #finished = false;
  #aborted = false;
  #completionScheduled = false;
  #finishListeners = [];

  constructor(database) {
    this.#database = database;
    queueMicrotask(() => this.#scheduleCompletion());
  }

  objectStore(name) {
    const records = this.#database.getStore(name);
    if (!records) throw new Error(`Missing object store: ${name}`);
    return new MemoryObjectStore(this, records);
  }

  queue(operation) {
    const request = new MemoryRequest();
    this.#pending += 1;
    queueMicrotask(() => {
      if (this.#aborted) {
        this.#pending -= 1;
        return;
      }
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        this.error = error;
        request.onerror?.({ target: request });
        this.onerror?.({ target: this });
        this.abort();
      } finally {
        this.#pending -= 1;
        this.#scheduleCompletion();
      }
    });
    return request;
  }

  abort() {
    if (this.#finished || this.#aborted) return;
    this.#aborted = true;
    this.#finished = true;
    queueMicrotask(() => {
      this.onabort?.({ target: this });
      for (const listener of this.#finishListeners) listener(false);
    });
  }

  onFinish(listener) {
    this.#finishListeners.push(listener);
  }

  #scheduleCompletion() {
    if (
      this.#finished ||
      this.#aborted ||
      this.#pending !== 0 ||
      this.#completionScheduled
    ) {
      return;
    }
    this.#completionScheduled = true;
    queueMicrotask(() => {
      this.#completionScheduled = false;
      if (this.#finished || this.#aborted || this.#pending !== 0) return;
      this.#finished = true;
      this.oncomplete?.({ target: this });
      for (const listener of this.#finishListeners) listener(true);
    });
  }
}

class MemoryObjectStore {
  #transaction;
  #records;

  constructor(transaction, records) {
    this.#transaction = transaction;
    this.#records = records;
  }

  get(key) {
    return this.#transaction.queue(() => clone(this.#records.get(key)));
  }

  getAll() {
    return this.#transaction.queue(() => [...this.#records.values()].map(clone));
  }

  getAllKeys() {
    return this.#transaction.queue(() => [...this.#records.keys()].map(clone));
  }

  put(value, key) {
    return this.#transaction.queue(() => {
      this.#records.set(key, clone(value));
      return key;
    });
  }

  delete(key) {
    return this.#transaction.queue(() => {
      this.#records.delete(key);
      return undefined;
    });
  }
}

class MemoryDatabase {
  onversionchange = null;
  #factory;
  #upgradeTransaction = null;
  #closed = false;

  constructor(factory) {
    this.#factory = factory;
  }

  get objectStoreNames() {
    const factory = this.#factory;
    return {
      contains(name) {
        return factory.hasStore(name);
      },
    };
  }

  setUpgradeTransaction(transaction) {
    this.#upgradeTransaction = transaction;
  }

  getStore(name) {
    return this.#factory.getStore(name);
  }

  createObjectStore(name) {
    if (!this.#upgradeTransaction) throw new Error("No active upgrade transaction");
    const records = this.#factory.createStore(name);
    return new MemoryObjectStore(this.#upgradeTransaction, records);
  }

  transaction(storeNames) {
    if (this.#closed) throw new Error("Database is closed");
    for (const name of Array.isArray(storeNames) ? storeNames : [storeNames]) {
      if (!this.#factory.hasStore(name)) throw new Error(`Missing object store: ${name}`);
    }
    return new MemoryTransaction(this);
  }

  close() {
    this.#closed = true;
  }
}

class MemoryIndexedDbFactory {
  #version;
  #stores;

  constructor({ version = 0, stores = {} } = {}) {
    this.#version = version;
    this.#stores = new Map(
      Object.entries(stores).map(([name, entries]) => [
        name,
        new Map(entries.map(([key, value]) => [key, clone(value)])),
      ]),
    );
  }

  get version() {
    return this.#version;
  }

  hasStore(name) {
    return this.#stores.has(name);
  }

  getStore(name) {
    return this.#stores.get(name);
  }

  createStore(name) {
    if (this.#stores.has(name)) throw new Error(`Object store already exists: ${name}`);
    const records = new Map();
    this.#stores.set(name, records);
    return records;
  }

  dump(name) {
    const records = this.#stores.get(name) ?? new Map();
    return new Map([...records].map(([key, value]) => [key, clone(value)]));
  }

  open(_name, requestedVersion) {
    const request = new MemoryRequest();
    queueMicrotask(() => {
      const database = new MemoryDatabase(this);
      request.result = database;
      if (requestedVersion > this.#version) {
        const oldVersion = this.#version;
        const transaction = new MemoryTransaction(database);
        database.setUpgradeTransaction(transaction);
        request.transaction = transaction;
        transaction.onFinish((completed) => {
          request.transaction = null;
          if (!completed) {
            request.error = transaction.error ?? new Error("Upgrade aborted");
            request.onerror?.({ target: request });
            return;
          }
          this.#version = requestedVersion;
          request.onsuccess?.({ target: request });
        });
        request.onupgradeneeded?.({
          oldVersion,
          newVersion: requestedVersion,
          target: request,
        });
      } else {
        request.onsuccess?.({ target: request });
      }
    });
    return request;
  }
}

async function withIndexedDb(factory, callback) {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: factory,
    writable: true,
  });
  try {
    return await callback();
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "indexedDB", previousDescriptor);
    } else {
      delete globalThis.indexedDB;
    }
  }
}

function makeProject(id, name, updatedAt = "2026-08-24T08:00:00.000Z") {
  return {
    format: "tm-object-project",
    formatVersion: 1,
    id,
    name,
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt,
    training: { epochs: 20, batchSize: 16, learningRate: 0.001 },
    classes: [
      {
        id: `class-${id}`,
        name: "水杯",
        color: "#7357E8",
        samples: [
          {
            id: `sample-${id}`,
            name: "cup.jpg",
            dataUrl: "data:image/jpeg;base64,/9j/2Q==",
            source: "upload",
            createdAt: "2026-08-20T08:00:00.000Z",
            width: 224,
            height: 224,
          },
        ],
      },
    ],
  };
}

function makeClassifierBundle() {
  return {
    format: "teachable-image-classifier",
    version: 1,
    createdAt: "2026-08-24T08:00:00.000Z",
    labels: ["水杯", "钥匙"],
    featureExtractor: {
      name: "MobileNet",
      version: 2,
      alpha: 0.5,
      embeddingSize: 1280,
    },
    artifacts: {
      modelTopology: {},
      weightSpecs: [],
      weightData: new ArrayBuffer(0),
    },
  };
}

test("upgrades v2 current-project data and supports a multi-project catalog", async () => {
  const legacyProject = makeProject("project-legacy", "旧项目");
  const preservedModel = { marker: "keep-the-v2-model" };
  const factory = new MemoryIndexedDbFactory({
    version: 2,
    stores: {
      projects: [["current-project", legacyProject]],
      models: [[legacyProject.id, preservedModel]],
    },
  });
  const storage = await getStorageModule();

  await withIndexedDb(factory, async () => {
    assert.deepEqual(await storage.listStoredProjects(), [
      {
        id: legacyProject.id,
        name: legacyProject.name,
        createdAt: legacyProject.createdAt,
        updatedAt: legacyProject.updatedAt,
        classCount: 1,
        sampleCount: 1,
        hasModel: true,
      },
    ]);
    assert.equal(factory.version, 3);
    assert.equal(factory.dump("projects").has("current-project"), false);
    assert.deepEqual(factory.dump("projects").get(`project:${legacyProject.id}`), legacyProject);
    assert.deepEqual(factory.dump("models").get(legacyProject.id), preservedModel);
    assert.equal(await storage.getLastOpenedProjectId(), legacyProject.id);
    assert.deepEqual(await storage.loadStoredProject(), legacyProject);

    const newerProject = makeProject(
      "project-newer",
      "新项目",
      "2026-08-25T08:00:00.000Z",
    );
    await storage.saveStoredProject(newerProject);
    assert.deepEqual(
      (await storage.listStoredProjects()).map(({ id }) => id),
      [newerProject.id, legacyProject.id],
    );
    assert.equal(await storage.getLastOpenedProjectId(), newerProject.id);
    assert.deepEqual(await storage.loadStoredProject(legacyProject.id), legacyProject);

    await storage.setLastOpenedProjectId(legacyProject.id);
    assert.deepEqual(await storage.loadStoredProject(), legacyProject);
    await storage.saveStoredProject(newerProject, { makeLastOpened: false });
    assert.equal(await storage.getLastOpenedProjectId(), legacyProject.id);
    await storage.setLastOpenedProjectId(newerProject.id);
    await storage.deleteStoredProject(legacyProject.id);
    assert.equal(await storage.loadStoredProjectById(legacyProject.id), null);
    assert.equal(await storage.getLastOpenedProjectId(), newerProject.id);
    assert.deepEqual(factory.dump("models").get(legacyProject.id), preservedModel);

    await storage.deleteStoredProject(newerProject.id);
    assert.equal(await storage.getLastOpenedProjectId(), null);
    assert.deepEqual(await storage.listStoredProjects(), []);
  });
});

test("atomically deletes all project data and rejects a late save after deletion", async () => {
  const deletedProject = makeProject("project-delete", "待删除项目");
  const savedModel = { marker: "saved-classifier" };
  const projectSummary = {
    id: deletedProject.id,
    name: deletedProject.name,
    createdAt: deletedProject.createdAt,
    updatedAt: deletedProject.updatedAt,
    classCount: 1,
    sampleCount: 1,
  };
  const factory = new MemoryIndexedDbFactory({
    version: 3,
    stores: {
      projects: [[`project:${deletedProject.id}`, deletedProject]],
      "project-catalog": [[deletedProject.id, projectSummary]],
      "project-settings": [["last-opened-project-id", deletedProject.id]],
      models: [[deletedProject.id, savedModel]],
    },
  });
  const storage = await getStorageModule();

  await withIndexedDb(factory, async () => {
    assert.deepEqual(await storage.loadStoredProject(), deletedProject);
    assert.deepEqual(await storage.listStoredProjects(), [{ ...projectSummary, hasModel: true }]);
    assert.deepEqual(factory.dump("models").get(deletedProject.id), savedModel);

    await storage.deleteStoredProjectAndModel(deletedProject.id);

    assert.equal(await storage.loadStoredProjectById(deletedProject.id), null);
    assert.deepEqual(await storage.listStoredProjects(), []);
    assert.equal(await storage.getLastOpenedProjectId(), null);
    assert.equal(factory.dump("models").has(deletedProject.id), false);
    assert.equal(
      factory
        .dump("project-settings")
        .has(`${storage.DELETED_PROJECT_TOMBSTONE_KEY_PREFIX}${deletedProject.id}`),
      true,
    );

    await assert.rejects(
      storage.saveStoredProject(deletedProject, { makeLastOpened: false }),
      /项目已被删除/,
    );
    assert.equal(await storage.loadStoredProjectById(deletedProject.id), null);
    assert.deepEqual(await storage.listStoredProjects(), []);

    const newProject = makeProject("project-after-delete", "新项目");
    await storage.saveStoredProject(newProject);
    assert.deepEqual(await storage.loadStoredProject(), newProject);
    assert.equal(await storage.getLastOpenedProjectId(), newProject.id);
  });
});

test("model writes honor deletion tombstones and signature upgrades use atomic CAS", async () => {
  const projectId = "project-model-cas";
  const factory = new MemoryIndexedDbFactory({
    version: 3,
    stores: {
      projects: [],
      "project-catalog": [],
      "project-settings": [],
      models: [],
    },
  });
  const storage = await getStorageModule();
  const modelStorage = await getModelStorageModule();
  const bundle = makeClassifierBundle();
  const versionOneSignature = `dataset-v1:sha256:${"1".repeat(64)}`;
  const versionTwoSignature = `dataset-v2:sha256:${"2".repeat(64)}`;

  await withIndexedDb(factory, async () => {
    const saved = await modelStorage.saveProjectClassifierModel(
      projectId,
      bundle,
      versionOneSignature,
    );
    assert.equal(saved.datasetSignature, versionOneSignature);

    assert.equal(
      await modelStorage.upgradeProjectClassifierModelDatasetSignature(
        projectId,
        `dataset-v1:sha256:${"3".repeat(64)}`,
        saved.savedAt,
        versionTwoSignature,
      ),
      false,
    );
    assert.equal(
      await modelStorage.upgradeProjectClassifierModelDatasetSignature(
        projectId,
        versionOneSignature,
        "2026-08-23T08:00:00.000Z",
        versionTwoSignature,
      ),
      false,
    );
    assert.equal(
      await modelStorage.upgradeProjectClassifierModelDatasetSignature(
        "project-model-missing",
        versionOneSignature,
        saved.savedAt,
        versionTwoSignature,
      ),
      false,
    );

    assert.equal(
      await modelStorage.upgradeProjectClassifierModelDatasetSignature(
        projectId,
        versionOneSignature,
        saved.savedAt,
        versionTwoSignature,
      ),
      true,
    );
    const upgraded = factory.dump("models").get(projectId);
    assert.equal(upgraded.datasetSignature, versionTwoSignature);
    assert.equal(upgraded.savedAt, saved.savedAt);
    assert.deepEqual(upgraded.bundle, bundle);

    assert.equal(
      await modelStorage.upgradeProjectClassifierModelDatasetSignature(
        projectId,
        versionOneSignature,
        saved.savedAt,
        versionTwoSignature,
      ),
      false,
    );

    await storage.deleteStoredProjectAndModel(projectId);
    assert.equal(factory.dump("models").has(projectId), false);
    assert.equal(
      await modelStorage.upgradeProjectClassifierModelDatasetSignature(
        projectId,
        versionTwoSignature,
        saved.savedAt,
        versionOneSignature,
      ),
      false,
    );
    await assert.rejects(
      modelStorage.saveProjectClassifierModel(projectId, bundle, versionTwoSignature),
      /project has been deleted/i,
    );
    assert.equal(factory.dump("models").has(projectId), false);
  });
});

test("rejects a model produced from a stale persisted project snapshot", async () => {
  const project = makeProject("project-stale-model", "模型项目");
  const factory = new MemoryIndexedDbFactory({
    version: 3,
    stores: {
      projects: [[`project:${project.id}`, project]],
      "project-catalog": [],
      "project-settings": [],
      models: [],
    },
  });
  const modelStorage = await getModelStorageModule();
  const bundle = makeClassifierBundle();
  const signature = `dataset-v2:sha256:${"4".repeat(64)}`;

  await withIndexedDb(factory, async () => {
    await modelStorage.saveProjectClassifierModel(
      project.id,
      bundle,
      signature,
      { expectedProjectUpdatedAt: project.updatedAt },
    );
    const firstStored = structuredClone(factory.dump("models").get(project.id));

    await assert.rejects(
      modelStorage.saveProjectClassifierModel(
        project.id,
        bundle,
        `dataset-v2:sha256:${"5".repeat(64)}`,
        { expectedProjectUpdatedAt: "2026-08-25T12:00:00.000Z" },
      ),
      /project changed during training/i,
    );
    assert.deepEqual(factory.dump("models").get(project.id), firstStored);
  });
});

test("rejects a stale optimistic save without overwriting the first update", async () => {
  const baseProject = makeProject("project-concurrent", "共同基线");
  const baseSummary = {
    id: baseProject.id,
    name: baseProject.name,
    createdAt: baseProject.createdAt,
    updatedAt: baseProject.updatedAt,
    classCount: 1,
    sampleCount: 1,
  };
  const factory = new MemoryIndexedDbFactory({
    version: 3,
    stores: {
      projects: [[`project:${baseProject.id}`, baseProject]],
      "project-catalog": [[baseProject.id, baseSummary]],
      "project-settings": [["last-opened-project-id", baseProject.id]],
      models: [],
    },
  });
  const storage = await getStorageModule();

  await withIndexedDb(factory, async () => {
    const firstUpdate = {
      ...structuredClone(baseProject),
      name: "标签页 A 的更新",
      updatedAt: "2026-08-25T09:00:00.000Z",
    };
    const staleSecondUpdate = {
      ...structuredClone(baseProject),
      name: "标签页 B 的旧基线更新",
      updatedAt: "2026-08-25T10:00:00.000Z",
    };

    await storage.saveStoredProject(firstUpdate, {
      makeLastOpened: false,
      expectedUpdatedAt: baseProject.updatedAt,
    });
    await assert.rejects(
      storage.saveStoredProject(staleSecondUpdate, {
        makeLastOpened: false,
        expectedUpdatedAt: baseProject.updatedAt,
      }),
      {
        name: "ProjectStorageConflictError",
        message: /项目已在其他标签页更新/,
      },
    );

    assert.deepEqual(await storage.loadStoredProjectById(baseProject.id), firstUpdate);
    assert.deepEqual(await storage.listStoredProjects(), [
      {
        ...baseSummary,
        name: firstUpdate.name,
        updatedAt: firstUpdate.updatedAt,
        hasModel: false,
      },
    ]);

    const newlyCreated = makeProject("project-create-once", "首次创建");
    await storage.saveStoredProject(newlyCreated, {
      makeLastOpened: false,
      expectedUpdatedAt: null,
    });
    await assert.rejects(
      storage.saveStoredProject(
        { ...newlyCreated, name: "不应覆盖", updatedAt: "2026-08-25T11:00:00.000Z" },
        { makeLastOpened: false, expectedUpdatedAt: null },
      ),
      { name: "ProjectStorageConflictError" },
    );
    assert.deepEqual(await storage.loadStoredProjectById(newlyCreated.id), newlyCreated);
  });
});

test("rejects a blocked open and closes a late successful connection", async () => {
  let closeCount = 0;
  const lateDatabase = {
    close() {
      closeCount += 1;
    },
  };
  const blockedFactory = {
    open() {
      const request = new MemoryRequest();
      queueMicrotask(() => {
        request.onblocked?.({ target: request });
        queueMicrotask(() => {
          request.result = lateDatabase;
          request.onsuccess?.({ target: request });
        });
      });
      return request;
    },
  };
  const storage = await getStorageModule();

  await withIndexedDb(blockedFactory, async () => {
    await assert.rejects(storage.openProjectDatabase(), /升级被其他页面阻止/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCount, 1);
  });
});
