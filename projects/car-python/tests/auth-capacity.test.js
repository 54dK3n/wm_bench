"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  AUTH_STORE_SCHEMA_VERSION,
  DEFAULT_MAX_USERS,
  DEFAULT_MAX_AUTH_SESSIONS,
  DEFAULT_MAX_PASSWORD_OPERATIONS,
  DEFAULT_MAX_PASSWORD_QUEUE,
  DEFAULT_PASSWORD_QUEUE_TIMEOUT_MS,
  DEFAULT_MAX_MUTATIONS_PER_BATCH,
  DEFAULT_MUTATION_BATCH_WINDOW_MS,
  DEFAULT_MAX_MUTATION_QUEUE,
  AuthStore
} = require("../backend/auth-store.js");
const {
  DEFAULT_MAX_REGISTRATION_ATTEMPTS,
  createServer
} = require("../server.js");

const PASSWORD = "Capacity-Test-Password-2026!";
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function temporaryRoot(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-auth-capacity-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.match(path.basename(resolved), /^chenlong-auth-capacity-/);
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

function deferred() {
  let resolve;
  const promise = new Promise(innerResolve => { resolve = innerResolve; });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function fixedId(prefix, index) {
  return `${prefix}_${index.toString(16).padStart(32, "0")}`;
}

function fixedInviteCode(index) {
  let value = index;
  let code = "";
  while (code.length < 8) {
    code = `${INVITE_ALPHABET[value % INVITE_ALPHABET.length]}${code}`;
    value = Math.floor(value / INVITE_ALPHABET.length);
  }
  return code;
}

function registration(username, teamName = username) {
  return {
    username,
    password: PASSWORD,
    displayName: username,
    teamAction: "create",
    teamName,
    group: "primary"
  };
}

async function writeFullAuthenticationStore(rootDir, userCount) {
  const seedStore = new AuthStore({ rootDir });
  await seedStore.register(registration("capacity-seed", "Capacity Seed Team"));
  const filePath = path.join(rootDir, "auth-store.json");
  const state = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  const passwordHash = state.users[0].passwordHash;
  const createdAt = "2026-08-28T00:00:00.000Z";
  state.schemaVersion = AUTH_STORE_SCHEMA_VERSION;
  state.revision += 1;
  state.sessions = [];
  state.teams = [];
  state.users = [];

  for (let index = 1; index <= userCount; index += 1) {
    const username = `capacity${String(index).padStart(4, "0")}`;
    const teamName = `Capacity Team ${index}`;
    const teamId = fixedId("tea", index);
    state.teams.push({
      id: teamId,
      teamName,
      teamNameKey: teamName.toLowerCase(),
      inviteCode: fixedInviteCode(index),
      createdAt
    });
    state.users.push({
      id: fixedId("usr", index),
      username,
      usernameKey: username,
      displayName: `Capacity ${index}`,
      teamId,
      teamName,
      group: "primary",
      role: index === 1 ? "admin" : "user",
      passwordHash,
      createdAt
    });
  }
  await fs.promises.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
  return { filePath, password: PASSWORD, initialRevision: state.revision };
}

async function startBackend(t, options = {}) {
  const dataDir = await temporaryRoot(t);
  const server = createServer({ ...options, dataDir });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function postRegistration(origin, username) {
  return fetch(`${origin}/api/v1/auth/register`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(registration(username, `Team ${username}`))
  });
}

test("authentication defaults reserve capacity for 2,000 accounts and their active sessions", async t => {
  assert.equal(DEFAULT_MAX_USERS, 2_000);
  assert.equal(DEFAULT_MAX_AUTH_SESSIONS, 8_000);
  assert.equal(DEFAULT_MAX_PASSWORD_OPERATIONS, 2);
  assert.ok(DEFAULT_MAX_PASSWORD_QUEUE >= 2_000);
  assert.ok(DEFAULT_PASSWORD_QUEUE_TIMEOUT_MS > 0);

  const store = new AuthStore({ rootDir: await temporaryRoot(t) });
  const status = await store.status();
  assert.equal(status.maxUsers, 2_000);
  assert.equal(status.maxSessions, 8_000);
  assert.equal(status.maxPasswordQueue, 2_000);
  assert.equal(status.maxMutationsPerBatch, 32);
  assert.equal(status.mutationBatchWindowMs, 10);
  assert.equal(status.maxMutationQueue, DEFAULT_MAX_MUTATION_QUEUE);
  assert.equal(status.queuedMutations, 0);
  assert.equal(status.processingMutationBatch, false);
  assert.equal(status.registrationOpen, true);
});

test("a valid persisted authentication store can contain and enumerate 2,000 users", async t => {
  const rootDir = await temporaryRoot(t);
  await writeFullAuthenticationStore(rootDir, 2_000);

  const loaded = new AuthStore({ rootDir });
  const status = await loaded.status();
  assert.equal(status.userCount, 2_000);
  assert.equal(status.maxUsers, 2_000);
  assert.equal((await loaded.listPublicUsers()).length, 2_000);
  await assert.rejects(
    loaded.register(registration("capacity-overflow", "Capacity Overflow Team")),
    error => error?.statusCode === 429 && error?.code === "USER_LIMIT_REACHED"
  );
});

test("group commit executes FIFO mutations once, isolates one failed candidate, and increments revisions per success", async t => {
  assert.equal(DEFAULT_MAX_MUTATIONS_PER_BATCH, 32);
  assert.equal(DEFAULT_MUTATION_BATCH_WINDOW_MS, 10);
  const rootDir = await temporaryRoot(t);
  const store = new AuthStore({
    rootDir,
    maxMutationsPerBatch: 4,
    mutationBatchWindowMs: 100
  });
  await store.register(registration("batch-admin", "Batch Admin Team"));
  const initialRevision = store.state.revision;
  const userId = store.state.users[0].id;
  const originalWriteState = store.writeState;
  let writeCount = 0;
  store.writeState = async (...args) => {
    writeCount += 1;
    return originalWriteState(...args);
  };
  const executionOrder = [];

  const results = await Promise.allSettled([
    store.withMutation(state => {
      executionOrder.push("first");
      state.users.find(user => user.id === userId).displayName = "First";
      return "first";
    }),
    store.withMutation(state => {
      executionOrder.push("failed");
      assert.equal(state.users.find(user => user.id === userId).displayName, "First");
      state.users.find(user => user.id === userId).displayName = "Must Be Discarded";
      throw new Error("expected isolated business failure");
    }),
    store.withMutation(state => {
      executionOrder.push("third");
      assert.equal(state.users.find(user => user.id === userId).displayName, "First");
      state.users.find(user => user.id === userId).displayName = "Third";
      return "third";
    }),
    store.withMutation(state => {
      executionOrder.push("fourth");
      assert.equal(state.users.find(user => user.id === userId).displayName, "Third");
      state.users.find(user => user.id === userId).displayName = "Fourth";
      return "fourth";
    })
  ]);

  assert.deepEqual(executionOrder, ["first", "failed", "third", "fourth"]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.match(results[1].reason?.message || "", /isolated business failure/);
  assert.equal(writeCount, 1);
  assert.equal(store.state.revision, initialRevision + 3);
  assert.equal(store.state.users[0].displayName, "Fourth");
  const persisted = JSON.parse(await fs.promises.readFile(path.join(rootDir, "auth-store.json"), "utf8"));
  assert.equal(persisted.revision, initialRevision + 3);
  assert.equal(persisted.users[0].displayName, "Fourth");
});

test("a failed group write rejects every successful candidate and leaves memory and disk unchanged", async t => {
  const rootDir = await temporaryRoot(t);
  const store = new AuthStore({
    rootDir,
    maxMutationsPerBatch: 2,
    mutationBatchWindowMs: 100
  });
  await store.register(registration("disk-admin", "Disk Admin Team"));
  const filePath = path.join(rootDir, "auth-store.json");
  const beforeSource = await fs.promises.readFile(filePath, "utf8");
  const beforeState = JSON.parse(JSON.stringify(store.state));
  const originalWriteState = store.writeState;
  const diskError = Object.assign(new Error("injected atomic write failure"), { code: "ENOSPC" });
  let writeAttempts = 0;
  store.writeState = async () => {
    writeAttempts += 1;
    throw diskError;
  };

  const failed = await Promise.allSettled([
    store.withMutation(state => {
      state.users[0].displayName = "Uncommitted One";
      return "one";
    }),
    store.withMutation(state => {
      state.users[0].displayName = "Uncommitted Two";
      return "two";
    })
  ]);
  assert.equal(writeAttempts, 1);
  assert.deepEqual(failed.map(result => result.status), ["rejected", "rejected"]);
  assert.ok(failed.every(result => result.reason === diskError));
  assert.deepEqual(store.state, beforeState);
  assert.equal(await fs.promises.readFile(filePath, "utf8"), beforeSource);

  store.writeState = originalWriteState;
  const recovered = await store.withMutation(state => {
    state.users[0].displayName = "Recovered";
    return "recovered";
  });
  assert.equal(recovered, "recovered");
  assert.equal(store.state.revision, beforeState.revision + 1);
  assert.equal(store.state.users[0].displayName, "Recovered");
  assert.equal(JSON.parse(await fs.promises.readFile(filePath, "utf8")).users[0].displayName, "Recovered");
});

test("concurrent public authentication writers preserve registration, login, logout, and managed-user updates", async t => {
  const rootDir = await temporaryRoot(t);
  const store = new AuthStore({ rootDir, maxMutationsPerBatch: 8 });
  const admin = await store.register(registration("race-admin", "Race Admin Team"));
  const participant = await store.register(registration("race-user", "Race User Team"));
  const actions = await Promise.all([
    store.login({ username: "race-user", password: PASSWORD }),
    store.register(registration("race-new", "Race New Team")),
    store.updateManagedUser(participant.user.id, {
      teamName: "Race Updated Team",
      group: "junior"
    }),
    store.logout(admin.token)
  ]);
  assert.equal(actions[0].user.username, "race-user");
  assert.equal(actions[1].user.username, "race-new");
  assert.equal(actions[2].changed, true);
  assert.equal(actions[3], true);

  const revisionBeforeNoop = store.state.revision;
  const originalWriteState = store.writeState;
  let noopWrites = 0;
  store.writeState = async (...args) => {
    noopWrites += 1;
    return originalWriteState(...args);
  };
  const unchanged = await store.updateManagedUser(participant.user.id, {
    teamName: "Race Updated Team",
    group: "junior"
  });
  assert.equal(unchanged.changed, false);
  assert.equal(store.state.revision, revisionBeforeNoop);
  assert.equal(noopWrites, 0);
  store.writeState = originalWriteState;

  const reloaded = new AuthStore({ rootDir });
  await reloaded.ready;
  const users = await reloaded.listPublicUsers();
  const updated = users.find(user => user.id === participant.user.id);
  assert.equal(updated.teamName, "Race Updated Team");
  assert.equal(updated.group, "junior");
  assert.ok(users.some(user => user.username === "race-new"));
  assert.equal((await reloaded.authenticate(actions[0].token)).user.username, "race-user");
  assert.equal((await reloaded.authenticate(actions[1].token)).user.username, "race-new");
  await assert.rejects(reloaded.authenticate(admin.token), error => error?.code === "AUTHENTICATION_REQUIRED");
});

test("expired-session cleanup is serialized with a concurrent managed-user update", async t => {
  let now = Date.parse("2026-08-28T00:00:00.000Z");
  const rootDir = await temporaryRoot(t);
  const store = new AuthStore({
    rootDir,
    now: () => now,
    authSessionTtlMs: 1_000,
    maxMutationsPerBatch: 2,
    mutationBatchWindowMs: 100
  });
  await store.register(registration("expiry-admin", "Expiry Admin Team"));
  const participant = await store.register(registration("expiry-user", "Expiry User Team"));
  const initialRevision = store.state.revision;
  now += 1_001;

  const outcomes = await Promise.allSettled([
    store.authenticate(participant.token),
    store.updateManagedUser(participant.user.id, {
      teamName: "Expiry Updated Team",
      group: "high"
    })
  ]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[0].reason?.code, "AUTHENTICATION_REQUIRED");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.equal(outcomes[1].value.changed, true);
  assert.equal(store.state.revision, initialRevision + 2);
  assert.equal(store.state.sessions.length, 0);
  const persisted = JSON.parse(await fs.promises.readFile(path.join(rootDir, "auth-store.json"), "utf8"));
  assert.equal(persisted.sessions.length, 0);
  const updated = persisted.users.find(user => user.id === participant.user.id);
  assert.equal(updated.teamName, "Expiry Updated Team");
  assert.equal(updated.group, "high");
});

test("500 real logins on a full 2,000-user store persist every session with bounded group writes", {
  timeout: 120_000
}, async t => {
  const rootDir = await temporaryRoot(t);
  const { filePath, password, initialRevision } = await writeFullAuthenticationStore(rootDir, 2_000);
  const beforeBytes = (await fs.promises.stat(filePath)).size;
  const store = new AuthStore({ rootDir });
  await store.ready;
  const originalWriteState = store.writeState;
  let writeCount = 0;
  store.writeState = async (...args) => {
    writeCount += 1;
    return originalWriteState(...args);
  };
  const started = performance.now();
  const authenticated = await Promise.all(Array.from({ length: 500 }, (_, offset) => (
    store.login({
      username: `capacity${String(offset + 1).padStart(4, "0")}`,
      password
    })
  )));
  const elapsedMs = Math.round(performance.now() - started);
  const afterBytes = (await fs.promises.stat(filePath)).size;
  assert.equal(authenticated.length, 500);
  assert.equal(store.state.sessions.length, 500);
  assert.equal(store.state.revision, initialRevision + 500);
  assert.ok(writeCount >= Math.ceil(500 / DEFAULT_MAX_MUTATIONS_PER_BATCH));
  assert.ok(writeCount < 500, `expected group commit to reduce 500 writes, received ${writeCount}`);

  const persisted = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  assert.equal(persisted.sessions.length, 500);
  assert.equal(persisted.revision, initialRevision + 500);
  const reloaded = new AuthStore({ rootDir });
  assert.equal((await reloaded.authenticate(authenticated[0].token)).user.username, "capacity0001");
  t.diagnostic(JSON.stringify({
    userCount: 2_000,
    successfulLogins: 500,
    elapsedMs,
    writeCount,
    beforeBytes,
    afterBytes,
    approximateRewriteBytes: writeCount * afterBytes
  }));
});

test("password operations wait in FIFO order instead of failing when both default slots are occupied", async t => {
  const store = new AuthStore({
    rootDir: await temporaryRoot(t),
    maxPasswordQueue: 3,
    passwordQueueTimeoutMs: 1_000
  });
  await store.ready;
  const firstGate = deferred();
  const secondGate = deferred();
  const thirdGate = deferred();
  const fourthGate = deferred();
  const started = [];
  let observedActive = 0;
  let maxObservedActive = 0;

  const operation = (label, gate) => async () => {
    started.push(label);
    observedActive += 1;
    maxObservedActive = Math.max(maxObservedActive, observedActive);
    await gate.promise;
    observedActive -= 1;
    return label;
  };

  const first = store.withPasswordOperation(operation("first", firstGate));
  const second = store.withPasswordOperation(operation("second", secondGate));
  await waitFor(() => started.length === 2, "both default password slots did not start");
  const third = store.withPasswordOperation(operation("third", thirdGate));
  const fourth = store.withPasswordOperation(operation("fourth", fourthGate));
  await waitFor(() => store.passwordOperationQueue.length === 2, "queued operations were not retained");
  assert.deepEqual(started, ["first", "second"]);

  secondGate.resolve();
  assert.equal(await second, "second");
  await waitFor(() => started.length === 3, "first queued operation did not start");
  assert.deepEqual(started, ["first", "second", "third"]);
  firstGate.resolve();
  assert.equal(await first, "first");
  await waitFor(() => started.length === 4, "second queued operation did not start");
  assert.deepEqual(started, ["first", "second", "third", "fourth"]);
  thirdGate.resolve();
  assert.equal(await third, "third");
  fourthGate.resolve();
  assert.equal(await fourth, "fourth");
  assert.equal(maxObservedActive, 2);
});

test("password operation queue rejects overflow and times out bounded waiters", async t => {
  const overflowStore = new AuthStore({
    rootDir: await temporaryRoot(t),
    maxPasswordOperations: 1,
    maxPasswordQueue: 1,
    passwordQueueTimeoutMs: 1_000
  });
  await overflowStore.ready;
  const activeGate = deferred();
  const active = overflowStore.withPasswordOperation(() => activeGate.promise);
  await waitFor(() => overflowStore.activePasswordOperations === 1, "active operation did not start");
  const queued = overflowStore.withPasswordOperation(async () => "queued");
  await waitFor(() => overflowStore.passwordOperationQueue.length === 1, "operation did not enter queue");
  await assert.rejects(
    overflowStore.withPasswordOperation(async () => "overflow"),
    error => error?.statusCode === 503 && error?.code === "AUTH_QUEUE_FULL"
  );
  activeGate.resolve("active");
  assert.equal(await active, "active");
  assert.equal(await queued, "queued");

  const timeoutStore = new AuthStore({
    rootDir: await temporaryRoot(t),
    maxPasswordOperations: 1,
    maxPasswordQueue: 1,
    passwordQueueTimeoutMs: 25
  });
  await timeoutStore.ready;
  const timeoutGate = deferred();
  const blocking = timeoutStore.withPasswordOperation(() => timeoutGate.promise);
  await waitFor(() => timeoutStore.activePasswordOperations === 1, "timeout blocker did not start");
  await assert.rejects(
    timeoutStore.withPasswordOperation(async () => "too-late"),
    error => error?.statusCode === 503 && error?.code === "AUTH_QUEUE_TIMEOUT"
  );
  assert.equal(timeoutStore.passwordOperationQueue.length, 0);
  timeoutGate.resolve("released");
  assert.equal(await blocking, "released");
});

test("closed registration still permits exactly one bootstrap administrator in an empty store", async t => {
  const store = new AuthStore({
    rootDir: await temporaryRoot(t),
    registrationOpen: false,
    maxPasswordOperations: 2
  });
  const results = await Promise.allSettled([
    store.register(registration("bootstrap-one", "Bootstrap Team One")),
    store.register(registration("bootstrap-two", "Bootstrap Team Two"))
  ]);
  const fulfilled = results.filter(result => result.status === "fulfilled");
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].value.bootstrapAdmin, true);
  assert.equal(fulfilled[0].value.user.role, "admin");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.statusCode, 403);
  assert.equal(rejected[0].reason?.code, "REGISTRATION_CLOSED");
  assert.equal((await store.listPublicUsers()).length, 1);
});

test("registration endpoint atomically applies a bounded global attempt window with Retry-After", async t => {
  assert.ok(DEFAULT_MAX_REGISTRATION_ATTEMPTS >= 2_000);
  const { origin, server } = await startBackend(t, {
    maxRegistrationAttempts: 1,
    registrationWindowMs: 60_000
  });
  const healthResponse = await fetch(`${origin}/api/health`);
  assert.equal(healthResponse.status, 200);
  const capabilities = (await healthResponse.json()).capabilities;
  assert.equal(capabilities.maxAuthUsers, 2_000);
  assert.equal(capabilities.maxAuthSessions, 8_000);
  assert.equal(capabilities.maxPasswordOperations, 2);
  assert.equal(capabilities.maxPasswordQueue, 2_000);
  assert.equal(capabilities.registrationOpen, true);
  assert.equal(capabilities.maxRegistrationAttempts, 1);
  assert.equal(capabilities.registrationWindowMs, 60_000);
  const responses = await Promise.all([
    postRegistration(origin, "rate-one"),
    postRegistration(origin, "rate-two")
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 429]);
  const limited = responses.find(response => response.status === 429);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get("retry-after") || "", /^\d+$/);
  assert.equal(limited.headers.get("set-cookie"), null);
  const payload = await limited.json();
  assert.equal(payload.error?.code, "REGISTRATION_RATE_LIMITED");
  assert.equal((await server.authStore.status()).userCount, 1);
});

test("HTTP registration closure preserves bootstrap administration and existing login", async t => {
  const { origin, server } = await startBackend(t, {
    registrationOpen: false,
    maxPasswordOperations: 1
  });
  const responses = await Promise.all([
    postRegistration(origin, "closed-one"),
    postRegistration(origin, "closed-two")
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 403]);
  const created = responses.find(response => response.status === 201);
  const rejected = responses.find(response => response.status === 403);
  const createdPayload = await created.json();
  assert.equal(createdPayload.bootstrapAdmin, true);
  assert.equal(createdPayload.user?.role, "admin");
  assert.equal(rejected.headers.get("set-cookie"), null);
  assert.equal((await rejected.json()).error?.code, "REGISTRATION_CLOSED");
  assert.equal((await server.authStore.status()).userCount, 1);

  const loginResponse = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({ username: createdPayload.user.username, password: PASSWORD })
  });
  assert.equal(loginResponse.status, 200);
  assert.equal((await loginResponse.json()).user?.role, "admin");
});
