"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const recordsSource = fs.readFileSync(path.join(root, "records.js"), "utf8");

class TestNode {}

class TestElement extends TestNode {
  constructor(tagName = "div", id = "") {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = "";
    this.className = "";
    this.textContent = "";
  }

  append(...children) {
    for (const child of children) {
      this.children.push(child);
      if (child instanceof TestNode) child.parentNode = this;
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) {
      if (child instanceof TestNode) child.parentNode = null;
    }
    this.children = [];
    this.textContent = "";
    this.append(...children);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  querySelector(selector) {
    if (selector === "span") return descendants(this).find(node => node.tagName === "SPAN") || null;
    return null;
  }

  closest(selector) {
    if (selector === "button[data-record-action][data-record-id]"
      && this.tagName === "BUTTON"
      && typeof this.dataset.recordAction === "string"
      && typeof this.dataset.recordId === "string") return this;
    return this.parentNode?.closest?.(selector) || null;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

function descendants(rootElement) {
  const values = [];
  const visit = element => {
    for (const child of element.children || []) {
      if (!(child instanceof TestNode)) continue;
      values.push(child);
      visit(child);
    }
  };
  visit(rootElement);
  return values;
}

function visibleText(element) {
  return [element.textContent, ...descendants(element).map(child => child.textContent)]
    .filter(Boolean)
    .join(" ");
}

function validSavedRecord(overrides = {}) {
  const savedAt = "2026-08-21T01:02:03.000Z";
  return {
    id: "sub_11111111111111111111111111111111",
    submissionId: null,
    sessionId: "ses_22222222222222222222222222222222",
    runId: "run_33333333333333333333333333333333",
    ownerUserId: "usr_44444444444444444444444444444444",
    teamId: "chenlong-team",
    taskId: "R2-GYI-MVP-01",
    taskName: "广阳岛综合巡检",
    score: 42.3,
    scoreMaximum: 100,
    status: "pending",
    verification: {
      status: "pending",
      reasonCodes: [],
      visionStatus: "unknown",
      verificationScope: {
        deterministic: { status: "unknown" },
        vision: "unknown"
      }
    },
    recordState: "saved",
    savedAt,
    submittedAt: null,
    receivedAt: savedAt,
    challengeDigest: "5".repeat(64),
    recordSha256: "6".repeat(64),
    recordByteLength: 12345,
    authoritative: false,
    user: {
      id: "usr_44444444444444444444444444444444",
      username: "chenlong-user",
      displayName: "辰龙选手",
      teamName: "辰龙一队",
      group: "primary",
      role: "user",
      createdAt: "2026-08-20T00:00:00.000Z"
    },
    ...overrides
  };
}

function validSubmittedRecord(overrides = {}) {
  const record = validSavedRecord({
    submissionId: "sub_11111111111111111111111111111111",
    status: "verified",
    verification: {
      status: "verified",
      reasonCodes: [],
      visionStatus: "not_used",
      verificationScope: {
        deterministic: { status: "complete" },
        vision: "not_used"
      }
    },
    recordState: "submitted",
    submittedAt: "2026-08-21T01:02:04.000Z"
  });
  return { ...record, ...overrides };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === "content-type" ? "application/json" : null },
    json: async () => payload
  };
}

function createHarness(responses) {
  const selectors = [
    "recordsTableBody", "recordTableWrap", "recordsLoading", "recordsEmpty", "recordsError",
    "recordsErrorMessage", "refreshRecordsButton", "recordDetailDialog", "recordDetailContent",
    "recordsNotice", "bestSubmissionHint", "metricTotal", "metricBest", "metricPending", "metricLatest",
    "metricLatestDate", "recordSearch", "recordStatusFilter", "closeRecordDetailButton"
  ];
  const elements = Object.fromEntries(selectors.map(id => [`#${id}`, new TestElement("div", id)]));
  elements["#recordStatusFilter"].value = "all";
  const documentListeners = new Map();
  const windowListeners = new Map();
  const requests = [];
  const document = {
    hidden: false,
    querySelector(selector) {
      if (!elements[selector]) throw new Error(`unexpected selector ${selector}`);
      return elements[selector];
    },
    createElement(tagName) {
      return new TestElement(tagName);
    },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    }
  };
  const location = {
    href: "http://127.0.0.1:6178/records.html",
    pathname: "/records.html",
    search: "",
    replace() {}
  };
  const window = {
    location,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    }
  };
  const context = vm.createContext({
    console,
    document,
    window,
    location,
    history: { pushState() {}, replaceState() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (!responses.length) throw new Error(`unexpected request ${url}`);
      return jsonResponse(responses.shift());
    },
    Node: TestNode,
    URL,
    URLSearchParams,
    Intl,
    Date,
    Error,
    Promise,
    Set,
    Map,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    encodeURIComponent,
    globalThis: null
  });
  context.globalThis = context;
  context.chenlongAuthReady = Promise.resolve();
  vm.runInContext(recordsSource, context, { filename: "records.js" });
  return { context, elements, requests, windowListeners, documentListeners };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

test("a malformed successful records response keeps the previous valid table", async () => {
  const validRecord = validSavedRecord();
  const malformedRecord = validSavedRecord({
    id: "sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    taskName: "不应显示的异常记录",
    recordState: "mystery",
    verification: null
  });
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [validRecord], authoritative: false },
    { schemaVersion: "chenlong.records/v1", records: [malformedRecord], authoritative: false }
  ]);
  await settle();
  assert.equal(harness.elements["#metricTotal"].textContent, "1");
  assert.match(visibleText(harness.elements["#recordsTableBody"]), /广阳岛综合巡检/);

  const refreshListener = harness.elements["#refreshRecordsButton"].listeners.get("click")[0];
  await refreshListener({ target: harness.elements["#refreshRecordsButton"] });

  assert.equal(harness.elements["#metricTotal"].textContent, "1");
  assert.match(visibleText(harness.elements["#recordsTableBody"]), /广阳岛综合巡检/);
  assert.doesNotMatch(visibleText(harness.elements["#recordsTableBody"]), /不应显示的异常记录/);
  assert.equal(harness.elements["#recordsNotice"].dataset.kind, "error");
  assert.match(harness.elements["#recordsNotice"].textContent, /已保留上一次成功读取的记录/);
});

test("a malformed submit receipt leaves the saved row submit-ready and never reports success", async () => {
  const validRecord = validSavedRecord();
  const malformedReceipt = {
    schemaVersion: "chenlong.record-submit-receipt/v1",
    recordId: validRecord.id,
    submissionId: validRecord.id,
    sessionId: validRecord.sessionId,
    submittedAt: "2026-08-21T01:02:04.000Z",
    duplicate: false,
    recordState: "submitted",
    verification: {
      schemaVersion: "chenlong.verification-report/v1",
      status: "pending",
      authoritative: false
    },
    authoritative: false
  };
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [validRecord], authoritative: false },
    malformedReceipt
  ]);
  await settle();
  const tableBody = harness.elements["#recordsTableBody"];
  const submitButton = descendants(tableBody).find(element => element.dataset.recordAction === "submit");
  assert.ok(submitButton, "a valid saved record must have a submit action");

  const tableClickListener = tableBody.listeners.get("click")[0];
  tableClickListener({ target: submitButton });
  await settle();

  const notice = harness.elements["#recordsNotice"];
  assert.equal(notice.dataset.kind, "error");
  assert.match(notice.textContent, /提交失败/);
  assert.doesNotMatch(notice.textContent, /已提交/);
  assert.equal(harness.elements["#metricPending"].textContent, "1");
  const restoredSubmitButton = descendants(tableBody)
    .find(element => element.dataset.recordAction === "submit");
  assert.ok(restoredSubmitButton, "the unchanged saved row must remain submit-ready");
  assert.equal(restoredSubmitButton.disabled, false);
  assert.equal(harness.requests[1].options.method, "POST");
});

test("submitted rows expose details but never create another submit action", async () => {
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [validSubmittedRecord()],
    authoritative: false
  }]);
  await settle();
  const actions = descendants(harness.elements["#recordsTableBody"])
    .filter(element => typeof element.dataset.recordAction === "string")
    .map(element => element.dataset.recordAction);
  assert.deepEqual(actions, ["detail"]);
  assert.equal(harness.elements["#metricPending"].textContent, "0");
});

test("the personal archive recommends the highest-scoring saved record", async () => {
  const lower = validSavedRecord({
    id: "sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    score: 71.2
  });
  const highest = validSavedRecord({
    id: "sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sessionId: "ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    runId: "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    score: 93.6,
    taskName: "广阳岛综合任务2"
  });
  const submitted = validSubmittedRecord({
    id: "sub_cccccccccccccccccccccccccccccccc",
    submissionId: "sub_cccccccccccccccccccccccccccccccc",
    sessionId: "ses_cccccccccccccccccccccccccccccccc",
    runId: "run_cccccccccccccccccccccccccccccccc",
    score: 99.9
  });
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [lower, highest, submitted],
    authoritative: false
  }]);
  await settle();
  const hint = harness.elements["#bestSubmissionHint"];
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /建议优先提交最高分/);
  assert.match(hint.textContent, /广阳岛综合任务2/);
  assert.match(hint.textContent, /93\.6 \/ 100/);
  assert.doesNotMatch(hint.textContent, /99\.9/);
});

test("record detail displays only the owner's archived Python source", async () => {
  const record = validSavedRecord();
  const sourceCode = "print('my archived Python code')\nrobot.forward(10)";
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [record], authoritative: false },
    {
      schemaVersion: "chenlong.record-detail/v1",
      record: record.raw || validSavedRecord(),
      session: {},
      manifest: {},
      verification: null,
      sourceCode,
      authoritative: false
    }
  ]);
  await settle();
  const detailButton = descendants(harness.elements["#recordsTableBody"])
    .find(element => element.dataset.recordAction === "detail");
  assert.ok(detailButton);
  const clickListener = harness.elements["#recordsTableBody"].listeners.get("click")[0];
  clickListener({ target: detailButton });
  await settle();
  assert.match(visibleText(harness.elements["#recordDetailContent"]), /本次运行的 Python 代码/);
  assert.match(visibleText(harness.elements["#recordDetailContent"]), /my archived Python code/);
});
