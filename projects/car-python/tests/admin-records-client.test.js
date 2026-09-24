"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "admin.js"), "utf8");
const teamScoresSource = fs.readFileSync(path.join(root, "admin-team-scores.js"), "utf8");
const authSource = fs.readFileSync(path.join(root, "auth.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const recordsHtml = fs.readFileSync(path.join(root, "records.html"), "utf8");
const recordsSource = fs.readFileSync(path.join(root, "records.js"), "utf8");

function functionSource(sourceText, name) {
  const start = sourceText.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const remaining = sourceText.slice(start + 1);
  const nextDeclaration = /\n\s*(?:async\s+)?function\s+/.exec(remaining);
  const end = nextDeclaration ? start + 1 + nextDeclaration.index : sourceText.length;
  return sourceText.slice(start, end);
}

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
    this.style = {};
  }

  append(...children) {
    for (const child of children) {
      this.children.push(child);
      if (child instanceof TestNode) child.parentNode = this;
    }
  }

  replaceChildren(...children) {
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
    if (selector === '[data-user-field="teamName"]') {
      return descendants(this).find(node => node.dataset.userField === "teamName") || null;
    }
    if (selector === '[data-user-field="group"]') {
      return descendants(this).find(node => node.dataset.userField === "group") || null;
    }
    if (selector === "button[data-user-save-id]") {
      return descendants(this).find(node => node.tagName === "BUTTON" && typeof node.dataset.userSaveId === "string") || null;
    }
    if (selector === "[data-user-edit-status]") {
      return descendants(this).find(node => Object.hasOwn(node.dataset, "userEditStatus")) || null;
    }
    return null;
  }

  closest(selector) {
    if (selector === "button[data-record-id]"
      && this.tagName === "BUTTON"
      && typeof this.dataset.recordId === "string") return this;
    if (selector === "button[data-user-save-id]"
      && this.tagName === "BUTTON"
      && typeof this.dataset.userSaveId === "string") return this;
    if (selector === "tr" && this.tagName === "TR") return this;
    return this.parentNode?.closest?.(selector) || null;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  click() {
    this.clicked = true;
    for (const listener of this.listeners.get("click") || []) listener({ target: this });
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  focus() {}

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1387, height: 860 };
  }
}

function descendants(element) {
  const nodes = [];
  const visit = parent => {
    for (const child of parent.children || []) {
      if (!(child instanceof TestNode)) continue;
      nodes.push(child);
      visit(child);
    }
  };
  visit(element);
  return nodes;
}

function visibleText(element) {
  return [element.textContent, ...descendants(element).map(child => child.textContent)]
    .filter(Boolean)
    .join(" ");
}

function submittedRecord(index, {
  username,
  teamName,
  taskId = "R2-GYI-MVP-01",
  taskName = "广阳岛综合任务1",
  group = "primary",
  capabilityUsage = { navigationSensors: false, roadControls: false, vision: false },
  autonomyMode = "standard",
  aiAutonomyVerified = false,
  score,
  submittedAt
} = {}) {
  const digit = String(index).slice(-1);
  const ownerUserId = `usr_${digit.repeat(32)}`;
  const id = `sub_${digit.repeat(32)}`;
  const savedAt = `2026-08-21T01:0${index}:00.000Z`;
  return {
    id,
    submissionId: id,
    sessionId: `ses_${digit.repeat(32)}`,
    runId: `run_${digit.repeat(32)}`,
    ownerUserId,
    teamId: `runtime-${index}`,
    taskId,
    taskName,
    score,
    scoreMaximum: 100,
    status: "verified",
    verification: {
      status: "verified",
      reasonCodes: [],
      visionStatus: "not_used",
      verificationScope: { deterministic: { status: "complete" }, vision: "not_used" }
    },
    recordState: "submitted",
    savedAt,
    submittedAt: submittedAt || `2026-08-21T01:0${index}:30.000Z`,
    receivedAt: savedAt,
    challengeDigest: digit.repeat(64),
    recordSha256: String((index + 5) % 10).repeat(64),
    recordByteLength: 1234 + index,
    authoritative: false,
    capabilityUsage: { navigationSensors: false, roadControls: false, vision: false, ...capabilityUsage },
    autonomyMode,
    aiAutonomyVerified,
    user: {
      id: ownerUserId,
      username,
      displayName: `${username} 显示名`,
      teamName,
      group,
      role: "user",
      createdAt: "2026-08-20T00:00:00.000Z"
    }
  };
}

function paginatedRecord(index, {
  username = `page-user-${String(index).padStart(2, "0")}`,
  teamName = `分页队伍-${String(index).padStart(2, "0")}`,
  group = index > 30 ? "high" : "primary",
  score = 101 - index
} = {}) {
  const identity = index.toString(16).padStart(32, "0");
  const savedAt = new Date(Date.UTC(2026, 7, 21, 3, 0, index)).toISOString();
  const submittedAt = new Date(Date.UTC(2026, 7, 21, 4, 0, index)).toISOString();
  const record = submittedRecord((index % 9) + 1, { username, teamName, group, score, submittedAt });
  return {
    ...record,
    id: `sub_${identity}`,
    submissionId: `sub_${identity}`,
    sessionId: `ses_${identity}`,
    runId: `run_${identity}`,
    ownerUserId: `usr_${identity}`,
    teamId: `page-team-${index}`,
    savedAt,
    submittedAt,
    receivedAt: savedAt,
    challengeDigest: index.toString(16).padStart(64, "0"),
    recordSha256: (index + 4096).toString(16).padStart(64, "0"),
    user: {
      ...record.user,
      id: `usr_${identity}`,
      username,
      displayName: `${username} 显示名`,
      teamName,
      group
    }
  };
}

function adminUser(index, {
  username = `user-${index}`,
  displayName = `用户 ${index}`,
  teamName = `第 ${index} 队`,
  group = "primary",
  role = "user",
  officialUserId = null,
  officialTeamId = null,
  createdAt = `2026-08-2${index}T00:00:00.000Z`
} = {}) {
  const digit = String(index).slice(-1);
  return {
    id: `usr_${digit.repeat(32)}`,
    username,
    displayName,
    teamName,
    group,
    role,
    officialUserId,
    officialTeamId,
    createdAt
  };
}

function publicUserProjection(user) {
  const { officialUserId: _officialUserId, officialTeamId: _officialTeamId, ...publicUser } = user;
  return publicUser;
}

function paginatedAdminUser(index) {
  const identity = (index + 8192).toString(16).padStart(32, "0");
  return {
    id: `usr_${identity}`,
    username: `account-${String(index).padStart(2, "0")}`,
    displayName: `用户 ${index}`,
    teamName: `用户队伍 ${index}`,
    group: "primary",
    role: "user",
    officialUserId: null,
    officialTeamId: null,
    createdAt: new Date(Date.UTC(2026, 7, 20, 0, 0, index)).toISOString()
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === "content-type" ? "application/json" : null },
    json: async () => payload
  };
}

const defaultMapLayout = {
  schemaVersion: "chenlong.guangyang-map-layout/v2",
  checkpoints: [[-2.4865, -2.4556], [7.1815, -3.2587], [6.471, 0.4479], [4.4324, 6.8726]],
  targets: [[-9.8687, -6.7181]],
  storage: [-10.7336, -8.0772],
  distractors: [[-8.0772, 5.4826]],
  obstacles: [[-10.9498, 2.0849]]
};

function mapConfigEnvelope({ revision = 0, layout = defaultMapLayout, digest = "a".repeat(64) } = {}) {
  const baseMapVersion = "2026.08-source-png-3d.3";
  return {
    schemaVersion: "chenlong.guangyang-map-config/v1",
    authoritative: false,
    mapId: "guangyang-island",
    baseMapVersion,
    mapVersion: revision === 0 ? baseMapVersion : `${baseMapVersion}@map-r${revision}-${digest.slice(0, 12)}`,
    revision,
    updatedAt: revision === 0 ? null : "2026-08-21T08:00:00.000Z",
    digest,
    layout
  };
}

function mapPoolsEnvelope() {
  const baseMapVersion = "2026.08-source-png-3d.3";
  const challenges = [
    ["R2-GYI-MVP-01", "广阳岛综合任务1", 8],
    ["R2-GYI-MVP-02", "广阳岛综合任务2", 10],
    ["R2-GYI-MVP-03", "广阳岛综合任务3", 12]
  ];
  return {
    schemaVersion: "chenlong.guangyang-map-pools-admin/v1",
    pools: challenges.map(([taskId, displayName, variantCount]) => ({
      taskId,
      displayName,
      variantCount,
      variants: Array.from({ length: variantCount }, (_item, index) => ({
        variantId: `map-${String(index + 1).padStart(2, "0")}`,
        variantNumber: index + 1,
        revision: 0,
        updatedAt: null,
        digest: "a".repeat(64),
        mapVersion: baseMapVersion
      }))
    })),
    assignments: [],
    authoritative: false
  };
}

function createHarness(responses, {
  userResponses = [], mapResponses = [], mapPoolsResponse = mapPoolsEnvelope()
} = {}) {
  const ids = [
    "adminRecordsTableBody", "adminRecordTableWrap", "adminRecordsLoading", "adminRecordsEmpty",
    "adminRecordsError", "adminRecordsErrorMessage", "adminNotice", "adminUsernameFilter",
    "adminTeamFilter", "adminTaskFilter", "adminGroupFilter", "adminStatusFilter", "adminAutonomyModeFilter", "adminScoreSort", "adminTeamRecordMode",
    "adminRecordDetailDialog", "adminRecordDetailContent", "adminRankingLoading", "adminRankingPending",
    "adminRankingEmpty", "adminRankingError", "adminRankingErrorMessage", "adminRankingTableWrap",
    "adminRankingTableBody", "refreshAdminRankingButton", "adminRankingSearch",
    "adminRankingCompletionFilter", "adminRankingValidityFilter", "adminRankingSafetyFilter",
    "adminRankingParticipants", "adminRankingFinalized", "adminRankingBestScore",
    "adminRankingCollisionFree", "adminMetricTotal", "adminMetricUsers", "adminMetricVerified",
    "adminMetricAverage", "adminMetricAi", "refreshAdminRecordsButton", "exportAdminRecordsButton", "closeAdminRecordDetailButton",
    "adminRecordsPagination", "adminRecordsPrevPage", "adminRecordsNextPage",
    "adminRecordsRange", "adminRecordsPageStatus",
    "adminTeamChallengeBestLoading", "adminTeamChallengeBestError", "adminTeamChallengeBestErrorMessage",
    "adminTeamChallengeBestTableWrap", "adminTeamChallengeBestBody",
    "adminTeamChallengeBestPagination", "adminTeamChallengeBestRange", "adminTeamChallengeBestPageStatus",
    "adminTeamChallengeBestPrevPage", "adminTeamChallengeBestNextPage", "exportTeamChallengeBestButton",
    "adminUsersTableBody", "adminUsersTableWrap", "adminUsersLoading", "adminUsersEmpty",
    "adminUsersError", "adminUsersErrorMessage", "adminUsersNotice", "adminUserUsernameFilter",
    "adminUserTeamFilter", "adminUserGroupFilter", "adminUserRoleFilter", "refreshAdminUsersButton", "exportAdminUsersButton",
    "adminUserMetricTotal", "adminUserMetricPrimary", "adminUserMetricJunior", "adminUserMetricHigh",
    "adminUserMetricAdmins", "adminUsersPagination", "adminUsersPrevPage", "adminUsersNextPage",
    "adminUsersRange", "adminUsersPageStatus", "adminMapVersion", "adminMapRevision",
    "adminMapUpdatedAt", "adminMapNotice", "adminMapEditorBody", "adminMapLoading", "adminMapError",
    "adminMapErrorMessage", "adminMapWorkspace", "adminMapStage", "adminMapMarkers", "adminMapPointList",
    "adminMapActions", "adminMapDraftStatus", "refreshAdminMapButton", "toggleAdminMapEditorButton",
    "restoreAdminMapButton", "saveAdminMapButton", "adminMapChallengeSelect", "adminMapVariantSelect",
    "adminMapAssignmentTableBody", "adminMapAssignmentEmpty", "adminMapAssignmentWrap"
  ];
  const elements = Object.fromEntries(ids.map(id => [`#${id}`, new TestElement("div", id)]));
  elements["#adminStatusFilter"].value = "all";
  elements["#adminAutonomyModeFilter"].value = "all";
  elements["#adminTaskFilter"].value = "all";
  elements["#adminGroupFilter"].value = "all";
  elements["#adminScoreSort"].value = "score-desc";
  elements["#adminTeamRecordMode"].value = "all";
  elements["#adminUserGroupFilter"].value = "all";
  elements["#adminUserRoleFilter"].value = "all";
  const downloads = [];
  class TestBlob {
    constructor(parts, options = {}) {
      this.content = parts.map(part => String(part)).join("");
      this.type = options.type || "";
    }
  }
  class TestURL extends URL {}
  TestURL.createObjectURL = blob => {
    downloads.push(blob);
    return `blob:test-${downloads.length}`;
  };
  TestURL.revokeObjectURL = () => {};
  const document = {
    body: new TestElement("body"),
    querySelector(selector) {
      if (!elements[selector]) throw new Error(`unexpected selector ${selector}`);
      return elements[selector];
    },
    createElement(tagName) {
      return new TestElement(tagName);
    }
  };
  const location = {
    href: "http://127.0.0.1:6178/admin.html",
    pathname: "/admin.html",
    search: "",
    replace() {}
  };
  const requests = [];
  const context = vm.createContext({
    console,
    document,
    location,
    window: { location, addEventListener() {}, confirm() { return true; }, setTimeout(callback) { callback(); } },
    history: { pushState() {}, replaceState() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (String(url).startsWith("/api/v1/admin/users")) {
        if (userResponses.length) return jsonResponse(userResponses.shift());
        return jsonResponse({ schemaVersion: "chenlong.admin-users/v1", users: [], authoritative: false });
      }
      if (url === "/api/v1/admin/map-pools") return jsonResponse(mapPoolsResponse);
      if (String(url).startsWith("/api/v1/admin/map-config/")) {
        if (mapResponses.length) {
          const response = mapResponses.shift();
          return jsonResponse(response.payload ?? response, response.status ?? 200);
        }
        return jsonResponse(mapConfigEnvelope());
      }
      if (!responses.length) throw new Error(`unexpected request ${url}`);
      return jsonResponse(responses.shift());
    },
    Node: TestNode,
    URL: TestURL,
    URLSearchParams,
    Blob: TestBlob,
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
  context.chenlongAuthReady = Promise.resolve({ role: "admin" });
  vm.runInContext(teamScoresSource, context, { filename: "admin-team-scores.js" });
  vm.runInContext(source, context, { filename: "admin.js" });
  return { elements, requests, downloads };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function fire(element, type, value) {
  element.value = value;
  const listener = element.listeners.get(type)?.[0];
  assert.ok(listener, `missing ${type} listener for #${element.id}`);
  listener({ target: element });
}

function click(element) {
  const listener = element.listeners.get("click")?.[0];
  assert.ok(listener, `missing click listener for #${element.id}`);
  listener({ target: element });
}

function tableRows(harness) {
  return harness.elements["#adminRecordsTableBody"].children.map(row => visibleText(row));
}

function teamScoreRows(harness) {
  return harness.elements["#adminTeamChallengeBestBody"].children.map(row => visibleText(row));
}

function userRows(harness) {
  return harness.elements["#adminUsersTableBody"].children;
}

function userRow(harness, userId) {
  return userRows(harness).find(row => row.dataset.userRowId === userId);
}

function userControl(row, field) {
  return descendants(row).find(node => node.dataset.userField === field);
}

function fireDelegated(harness, type, target) {
  const container = harness.elements["#adminUsersTableBody"];
  const listener = container.listeners.get(type)?.[0];
  assert.ok(listener, `missing delegated ${type} listener`);
  listener({ target });
}

test("an administrator logging in with returnTo=/ lands directly on the backend", () => {
  let destination = null;
  const window = {
    location: {
      search: "?returnTo=%2F",
      origin: "http://127.0.0.1:6178",
      replace(value) { destination = value; }
    }
  };
  vm.runInNewContext(`${functionSource(authSource, "safeReturnTo")}\n${functionSource(authSource, "redirectAfterAuthentication")}\nredirectAfterAuthentication({ role: "admin" });`, {
    window,
    URL,
    URLSearchParams
  });
  assert.equal(destination, "/admin.html");
});

test("group controls and capability markers remain administrator-only", () => {
  assert.match(adminHtml, /id="adminGroupFilter"/);
  assert.match(adminHtml, /<option value="primary">小学组<\/option>/);
  assert.match(adminHtml, /<option value="junior">初中组<\/option>/);
  assert.match(adminHtml, /<option value="high">高中组<\/option>/);
  assert.match(adminHtml, /<th>能力标记<\/th>/);
  assert.match(source, /hasExactKeys\(value\.capabilityUsage, \["navigationSensors", "roadControls", "vision"\]\)/);
  assert.doesNotMatch(recordsHtml, /能力标记|capabilityUsage|capability-badge/);
  assert.doesNotMatch(recordsSource, /能力标记|capabilityUsage|capability-badge/);
});

test("administrator user management exposes only the requested editable account projection", () => {
  for (const id of [
    "adminUsersTableBody", "adminUserUsernameFilter", "adminUserTeamFilter",
    "adminUserGroupFilter", "adminUserRoleFilter", "refreshAdminUsersButton"
  ]) {
    assert.match(adminHtml, new RegExp(`id=["']${id}["']`), `missing administrator user control #${id}`);
  }
  assert.match(adminHtml, /<th>用户名<\/th><th>队伍名<\/th><th>分组<\/th><th>角色<\/th><th>注册时间<\/th>/);
  assert.match(adminHtml, /不提供删除账号、修改角色或重置密码功能/);
  assert.match(source, /method:\s*"PATCH"/);
  assert.match(source, /body:\s*\{ teamName, group \}/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/,
    "administrator-controlled values must only be rendered through DOM text/value properties");
  assert.doesNotMatch(source, /method:\s*["']DELETE["']|resetPassword|changeRole/);
});

test("administrator user list accepts exact SSO identity metadata without relaxing record-user data", async () => {
  const officialUser = adminUser(5, {
    username: "official-user",
    displayName: "官网选手",
    teamName: "官网代表队",
    officialUserId: "website-user-5",
    officialTeamId: "website-team-5"
  });
  const record = submittedRecord(5, {
    username: officialUser.username,
    teamName: officialUser.teamName,
    group: officialUser.group,
    score: 93
  });
  record.user = publicUserProjection(officialUser);
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [record],
    authoritative: false
  }], { userResponses: [{
    schemaVersion: "chenlong.admin-users/v1",
    users: [officialUser],
    authoritative: false
  }] });
  await settle();

  assert.equal(harness.elements["#adminUsersError"].hidden, true);
  assert.equal(harness.elements["#adminUsersTableWrap"].hidden, false);
  assert.match(visibleText(userRows(harness)[0]), /official-user/);
  assert.equal(harness.elements["#adminTeamChallengeBestLoading"].hidden, true);
  assert.equal(harness.elements["#adminTeamChallengeBestError"].hidden, true);
  assert.equal(harness.elements["#adminTeamChallengeBestTableWrap"].hidden, false);
  assert.match(teamScoreRows(harness).join(" "), /官网代表队/);
  assert.match(teamScoreRows(harness).join(" "), /93\.0 \/ 100/);

  const leakedRecord = { ...record, user: { ...record.user, officialUserId: "website-user-5" } };
  const rejectedHarness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [leakedRecord],
    authoritative: false
  }], { userResponses: [{
    schemaVersion: "chenlong.admin-users/v1",
    users: [officialUser],
    authoritative: false
  }] });
  await settle();
  assert.equal(rejectedHarness.elements["#adminRecordsError"].hidden, false,
    "official identity metadata must remain excluded from formal-record public users");
});

test("administrator user list rejects malformed or misplaced SSO identity metadata", async () => {
  const participant = adminUser(8, { username: "identity-safe", teamName: "身份校验队" });
  const malformedUsers = [
    { ...participant, officialUserId: "website-user-8", officialTeamId: null },
    { ...participant, officialUserId: 123, officialTeamId: "website-team-8" },
    { ...participant, officialUserId: "website user 8", officialTeamId: "website-team-8" },
    {
      ...participant,
      role: "admin",
      teamName: null,
      group: null,
      officialUserId: "website-admin-8",
      officialTeamId: "website-team-8"
    },
    { ...participant, unexpected: true }
  ];

  for (const malformedUser of malformedUsers) {
    const harness = createHarness([{
      schemaVersion: "chenlong.records/v1",
      records: [],
      authoritative: false
    }], { userResponses: [{
      schemaVersion: "chenlong.admin-users/v1",
      users: [malformedUser],
      authoritative: false
    }] });
    await settle();
    assert.equal(harness.elements["#adminUsersError"].hidden, false);
    assert.equal(harness.elements["#adminTeamChallengeBestLoading"].hidden, true);
    assert.equal(harness.elements["#adminTeamChallengeBestError"].hidden, false);
  }
});

test("team score summary leaves loading state when an initial dependency fails and recovers on retry", async () => {
  const validUser = adminUser(6, { username: "retry-user", teamName: "重试队" });
  const legacySevenFieldUser = publicUserProjection(validUser);
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [],
    authoritative: false
  }], { userResponses: [
    { schemaVersion: "chenlong.admin-users/v1", users: [legacySevenFieldUser], authoritative: false },
    { schemaVersion: "chenlong.admin-users/v1", users: [validUser], authoritative: false }
  ] });
  await settle();

  assert.equal(harness.elements["#adminUsersError"].hidden, false);
  assert.equal(harness.elements["#adminTeamChallengeBestLoading"].hidden, true);
  assert.equal(harness.elements["#adminTeamChallengeBestError"].hidden, false);
  assert.match(harness.elements["#adminTeamChallengeBestErrorMessage"].textContent, /用户列表读取失败/);
  assert.equal(harness.elements["#adminTeamChallengeBestTableWrap"].hidden, true);
  assert.equal(harness.elements["#exportTeamChallengeBestButton"].disabled, true);

  const refresh = harness.elements["#refreshAdminUsersButton"].listeners.get("click")?.[0];
  assert.ok(refresh);
  await refresh({ target: harness.elements["#refreshAdminUsersButton"] });
  await settle();
  assert.equal(harness.elements["#adminTeamChallengeBestError"].hidden, true);
  assert.equal(harness.elements["#adminTeamChallengeBestLoading"].hidden, true);
  assert.equal(harness.elements["#adminTeamChallengeBestTableWrap"].hidden, false);
  assert.match(teamScoreRows(harness).join(" "), /重试队/);

  const malformedRecord = submittedRecord(9, { username: "bad-record", teamName: "坏记录队", score: 90 });
  malformedRecord.recordState = "saved";
  malformedRecord.submittedAt = null;
  const recordFailureHarness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [malformedRecord],
    authoritative: false
  }], { userResponses: [{
    schemaVersion: "chenlong.admin-users/v1",
    users: [validUser],
    authoritative: false
  }] });
  await settle();
  assert.equal(recordFailureHarness.elements["#adminRecordsError"].hidden, false);
  assert.equal(recordFailureHarness.elements["#adminTeamChallengeBestLoading"].hidden, true);
  assert.equal(recordFailureHarness.elements["#adminTeamChallengeBestError"].hidden, false);
  assert.match(recordFailureHarness.elements["#adminTeamChallengeBestErrorMessage"].textContent, /正式提交记录读取失败/);
});

test("administrator users filter, edit through PATCH, and immediately update record ownership views", async () => {
  const alpha = adminUser(1, {
    username: "alpha-user",
    displayName: "Alpha 显示名",
    teamName: "甲队",
    group: "primary"
  });
  const beta = adminUser(2, {
    username: "beta-admin",
    displayName: "Beta 管理员",
    teamName: null,
    group: null,
    role: "admin"
  });
  const updatedAlpha = { ...publicUserProjection(alpha), teamName: "新甲队", group: "high" };
  const record = submittedRecord(1, {
    username: alpha.username,
    teamName: alpha.teamName,
    group: alpha.group,
    score: 91
  });
  record.user = publicUserProjection(alpha);
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [record], authoritative: false }
  ], { userResponses: [
    { schemaVersion: "chenlong.admin-users/v1", users: [alpha, beta], authoritative: false },
    {
      schemaVersion: "chenlong.admin-user-update/v1",
      user: updatedAlpha,
      changed: true,
      authoritative: false
    }
  ] });
  await settle();

  assert.equal(harness.elements["#adminUserMetricTotal"].textContent, "2");
  assert.equal(harness.elements["#adminUserMetricPrimary"].textContent, "1");
  assert.equal(harness.elements["#adminUserMetricJunior"].textContent, "0");
  assert.equal(harness.elements["#adminUserMetricHigh"].textContent, "0");
  assert.equal(harness.elements["#adminUserMetricAdmins"].textContent, "1");

  fire(harness.elements["#adminUserRoleFilter"], "change", "admin");
  assert.equal(userRows(harness).length, 1);
  assert.match(visibleText(userRows(harness)[0]), /beta-admin/);
  assert.match(visibleText(userRows(harness)[0]), /不参与队伍和分组管理/);
  assert.equal(userControl(userRows(harness)[0], "teamName") ?? null, null);
  assert.equal(userControl(userRows(harness)[0], "group") ?? null, null);
  fire(harness.elements["#adminUserRoleFilter"], "change", "all");
  fire(harness.elements["#adminUserTeamFilter"], "input", "甲");
  assert.equal(userRows(harness).length, 1);
  assert.match(visibleText(userRows(harness)[0]), /alpha-user/);
  fire(harness.elements["#adminUserTeamFilter"], "input", "");

  const row = userRow(harness, alpha.id);
  const teamInput = userControl(row, "teamName");
  const groupSelect = userControl(row, "group");
  teamInput.value = "新甲队";
  fireDelegated(harness, "input", teamInput);
  groupSelect.value = "high";
  fireDelegated(harness, "change", groupSelect);
  const saveButton = descendants(row).find(node => typeof node.dataset.userSaveId === "string");
  assert.equal(saveButton.disabled, false);
  assert.match(visibleText(saveButton), /确认修改/);
  fireDelegated(harness, "click", saveButton);
  await settle();

  const patchRequest = harness.requests.find(request => request.options.method === "PATCH");
  assert.ok(patchRequest);
  assert.equal(patchRequest.url, `/api/v1/admin/users/${alpha.id}`);
  assert.deepEqual(Object.keys(JSON.parse(patchRequest.options.body)).sort(), ["group", "teamName"]);
  assert.deepEqual(JSON.parse(patchRequest.options.body), { teamName: "新甲队", group: "high" });
  assert.equal(patchRequest.options.credentials, "same-origin");
  assert.equal(patchRequest.options.headers["Content-Type"], "application/json");

  const savedRow = userRow(harness, alpha.id);
  assert.equal(userControl(savedRow, "teamName").value, "新甲队");
  assert.equal(userControl(savedRow, "group").value, "high");
  assert.match(harness.elements["#adminUsersNotice"].textContent, /已保存/);
  assert.match(tableRows(harness).join(" "), /新甲队/,
    "the formal record table must immediately use the trusted updated account projection");
  assert.match(tableRows(harness).join(" "), /高中组/);
  fire(harness.elements["#adminGroupFilter"], "change", "high");
  assert.match(tableRows(harness).join(" "), /alpha-user/,
    "record group filtering must use the updated account group without a manual refresh");
});

test("administrator users reject malformed update receipts and keep the prior trusted projection", async () => {
  const user = adminUser(3, { username: "receipt-safe", teamName: "原队伍" });
  const record = submittedRecord(3, { username: user.username, teamName: user.teamName, score: 82 });
  record.user = publicUserProjection(user);
  const mismatchedReceiptUser = { ...publicUserProjection(user), teamName: "被串改队伍", group: "high" };
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [record], authoritative: false }
  ], { userResponses: [
    { schemaVersion: "chenlong.admin-users/v1", users: [user], authoritative: false },
    {
      schemaVersion: "chenlong.admin-user-update/v1",
      user: mismatchedReceiptUser,
      changed: true,
      authoritative: false
    }
  ] });
  await settle();

  const row = userRow(harness, user.id);
  const teamInput = userControl(row, "teamName");
  teamInput.value = "期望队伍";
  fireDelegated(harness, "input", teamInput);
  const saveButton = descendants(row).find(node => typeof node.dataset.userSaveId === "string");
  fireDelegated(harness, "click", saveButton);
  await settle();

  assert.equal(harness.elements["#adminUsersNotice"].dataset.kind, "error");
  assert.match(harness.elements["#adminUsersNotice"].textContent, /回执与本次操作不一致/);
  assert.match(tableRows(harness).join(" "), /原队伍/);
  assert.doesNotMatch(tableRows(harness).join(" "), /被串改队伍|期望队伍/);
  const retainedRow = userRow(harness, user.id);
  assert.equal(userControl(retainedRow, "teamName").value, "期望队伍",
    "the unsaved administrator draft should remain available after a rejected receipt");
  const retainedButton = descendants(retainedRow).find(node => typeof node.dataset.userSaveId === "string");
  assert.equal(retainedButton.disabled, false);
});

test("administrator users retain the last valid list when a refresh response is malformed", async () => {
  const user = adminUser(4, { username: "list-safe", teamName: "安全列表队" });
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [], authoritative: false }
  ], { userResponses: [
    { schemaVersion: "chenlong.admin-users/v1", users: [user], authoritative: false },
    { schemaVersion: "chenlong.admin-users/v1", users: [{ ...user, role: "owner" }], authoritative: false }
  ] });
  await settle();
  const refresh = harness.elements["#refreshAdminUsersButton"].listeners.get("click")?.[0];
  assert.ok(refresh);
  await refresh({ target: harness.elements["#refreshAdminUsersButton"] });

  assert.match(visibleText(userRows(harness)[0]), /list-safe/);
  assert.equal(harness.elements["#adminUsersNotice"].dataset.kind, "error");
  assert.match(harness.elements["#adminUsersNotice"].textContent, /已保留上一次成功读取/);
});

test("administrator exports the complete current filtered user and formal-record views as safe CSV", async () => {
  const user = adminUser(7, {
    username: "export-user",
    displayName: "导出用户",
    teamName: "=SUM(1,1)",
    group: "junior"
  });
  const record = submittedRecord(7, {
    username: user.username,
    teamName: user.teamName,
    group: user.group,
    score: 96,
    submittedAt: "2026-08-22T09:00:00.000Z"
  });
  record.user = publicUserProjection(user);
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [record], authoritative: false }
  ], { userResponses: [
    { schemaVersion: "chenlong.admin-users/v1", users: [user], authoritative: false }
  ] });
  await settle();

  assert.equal(harness.elements["#exportAdminUsersButton"].disabled, false);
  assert.equal(harness.elements["#exportAdminRecordsButton"].disabled, false);
  const requestCountBeforeExport = harness.requests.length;
  click(harness.elements["#exportAdminUsersButton"]);
  click(harness.elements["#exportAdminRecordsButton"]);
  assert.equal(harness.downloads.length, 2);

  const [usersCsv, recordsCsv] = harness.downloads.map(item => item.content);
  assert.match(usersCsv, /^\uFEFF"用户名","显示名称","队伍名称","参赛分组","角色","注册时间"/);
  assert.match(usersCsv, /"'=SUM\(1,1\)"/,
    "values that spreadsheet software could treat as formulas must be exported as text");
  assert.match(recordsCsv, /^\uFEFF"记录编号","用户名","显示名称"/);
  assert.match(recordsCsv, /"export-user"/);
  assert.doesNotMatch(recordsCsv, /sessionId|runId|recordSha256|password|invite/i,
    "the compact export must not contain credentials, source data, or replay-only identifiers");
  assert.equal(harness.requests.length, requestCountBeforeExport,
    "export must use the already validated administrator data and never issue a second data request");
});

test("administrator user and record refresh actions remain independent", async () => {
  const firstUser = adminUser(1, { username: "first-user", teamName: "第一队" });
  const secondUser = adminUser(2, { username: "second-user", teamName: "第二队", group: "junior" });
  const firstRecord = submittedRecord(1, { username: "record-one", teamName: "记录一队", score: 81 });
  const secondRecord = submittedRecord(2, { username: "record-two", teamName: "记录二队", score: 92 });
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [firstRecord], authoritative: false },
    { schemaVersion: "chenlong.records/v1", records: [firstRecord, secondRecord], authoritative: false }
  ], { userResponses: [
    { schemaVersion: "chenlong.admin-users/v1", users: [firstUser], authoritative: false },
    { schemaVersion: "chenlong.admin-users/v1", users: [firstUser, secondUser], authoritative: false }
  ] });
  await settle();

  const userRequestCount = () => harness.requests.filter(request => String(request.url).startsWith("/api/v1/admin/users")).length;
  const recordRequestCount = () => harness.requests.filter(request => String(request.url).startsWith("/api/v1/admin/records?")).length;
  assert.equal(userRequestCount(), 1);
  assert.equal(recordRequestCount(), 1);

  const refreshUsers = harness.elements["#refreshAdminUsersButton"].listeners.get("click")?.[0];
  assert.ok(refreshUsers);
  await refreshUsers({ target: harness.elements["#refreshAdminUsersButton"] });
  assert.equal(userRequestCount(), 2);
  assert.equal(recordRequestCount(), 1, "refreshing users must not reload formal records");
  assert.equal(harness.elements["#adminUserMetricTotal"].textContent, "2");
  assert.match(visibleText(userRows(harness)[1]), /second-user/);
  assert.doesNotMatch(tableRows(harness).join(" "), /record-two/);

  const refreshRecords = harness.elements["#refreshAdminRecordsButton"].listeners.get("click")?.[0];
  assert.ok(refreshRecords);
  await refreshRecords({ target: harness.elements["#refreshAdminRecordsButton"] });
  assert.equal(recordRequestCount(), 2);
  assert.equal(userRequestCount(), 2, "refreshing formal records must not reload users");
  assert.equal(harness.elements["#adminMetricTotal"].textContent, "2");
  assert.match(tableRows(harness).join(" "), /record-two/);
});

test("administrator record details remain reachable after the compact layout change", async () => {
  const record = submittedRecord(6, {
    username: "detail-user",
    teamName: "详情队",
    capabilityUsage: { navigationSensors: true, roadControls: true, vision: true },
    autonomyMode: "ai",
    aiAutonomyVerified: true,
    score: 96
  });
  const verification = {
    schemaVersion: "chenlong.verification-report/v1",
    authoritative: false,
    status: "verified",
    reasonCodes: [],
    verificationScope: { deterministic: { status: "complete" }, vision: "not_used" },
    visionStatus: "not_used"
  };
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [record], authoritative: false },
    {
      schemaVersion: "chenlong.record-detail/v1",
      record,
      session: {},
      manifest: {},
      verification,
      sourceCode: "print('detail-source-visible')",
      authoritative: false
    }
  ]);
  await settle();

  const detailButton = descendants(harness.elements["#adminRecordsTableBody"])
    .find(node => node.dataset.recordId === record.id);
  assert.ok(detailButton, "the compact record table must retain its details action");
  const openDetails = harness.elements["#adminRecordsTableBody"].listeners.get("click")?.[0];
  assert.ok(openDetails);
  openDetails({ target: detailButton });
  await settle();

  assert.equal(harness.elements["#adminRecordDetailDialog"].open, true);
  assert.ok(harness.requests.some(request => request.url === `/api/v1/admin/records/${record.id}`));
  const detailText = visibleText(harness.elements["#adminRecordDetailContent"]);
  assert.match(detailText, /detail-user/);
  assert.match(detailText, /详情队/);
  assert.match(detailText, /AI 自主（视觉、导航和道路控制闭环已验证）/);
  assert.match(detailText, /导航传感、道路控制、视觉感知/);
  assert.match(detailText, /本次提交的 Python 代码/);
  assert.match(detailText, /detail-source-visible/);
  assert.match(tableRows(harness).join(" "), /视觉感知/,
    "a trusted visual-perception marker must be visible in the administrator table");

  const closeDetails = harness.elements["#closeAdminRecordDetailButton"].listeners.get("click")?.[0];
  assert.ok(closeDetails);
  closeDetails({ target: harness.elements["#closeAdminRecordDetailButton"] });
  assert.equal(harness.elements["#adminRecordDetailDialog"].open, false);
});

test("administrator records filter registered identities and sort stable team-best scores", async () => {
  const records = [
    submittedRecord(1, { username: "alpha", teamName: "CAFÉ车队", group: "primary", capabilityUsage: { navigationSensors: true, roadControls: false }, score: 80, submittedAt: "2026-08-21T02:04:30.000Z" }),
    submittedRecord(2, { username: "beta", teamName: "CAFÉ车队", group: "junior", capabilityUsage: { navigationSensors: false, roadControls: true }, score: 95, submittedAt: "2026-08-21T02:02:30.000Z" }),
    submittedRecord(3, { username: "gamma", teamName: "辰龙乙队", group: "high", score: 80, submittedAt: "2026-08-21T02:04:30.000Z" }),
    submittedRecord(4, { username: "legacy-one", teamName: null, score: 70, submittedAt: "2026-08-21T02:05:30.000Z" }),
    submittedRecord(5, { username: "legacy-two", teamName: null, score: 60, submittedAt: "2026-08-21T02:01:30.000Z" })
  ];
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records,
    authoritative: false
  }]);
  await settle();

  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(alpha|beta|gamma|legacy-one|legacy-two)\b/)?.[0]),
    ["beta", "alpha", "gamma", "legacy-one", "legacy-two"],
    "equal scores must retain their source order");
  assert.match(tableRows(harness).join(" "), /CAFÉ车队/);
  assert.doesNotMatch(tableRows(harness).join(" "), /runtime-/,
    "runtime teamId values must never be presented as registered team names");
  assert.match(tableRows(harness)[0], /道路控制/);
  assert.match(tableRows(harness)[1], /导航传感/);

  fire(harness.elements["#adminGroupFilter"], "change", "junior");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(beta)\b/)?.[0]), ["beta"],
    "group filtering must use the frozen account group value");
  assert.match(tableRows(harness).join(" "), /初中组/);
  fire(harness.elements["#adminGroupFilter"], "change", "all");

  fire(harness.elements["#adminTeamRecordMode"], "change", "best-per-team");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(beta|gamma|legacy-one|legacy-two)\b/)?.[0]),
    ["beta", "gamma", "legacy-one", "legacy-two"],
    "same registered team names share one best row while legacy null teams stay separate");

  fire(harness.elements["#adminGroupFilter"], "change", "primary");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(alpha|legacy-one|legacy-two)\b/)?.[0]),
    ["alpha", "legacy-one", "legacy-two"],
    "group filtering must happen before selecting each team's highest-scoring row");
  fire(harness.elements["#adminGroupFilter"], "change", "all");

  fire(harness.elements["#adminTeamFilter"], "input", "cafe\u0301");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(beta)\b/)?.[0]), ["beta"],
    "team filtering must normalize Unicode before matching");

  fire(harness.elements["#adminTeamFilter"], "input", "");
  fire(harness.elements["#adminTeamRecordMode"], "change", "all");
  fire(harness.elements["#adminUsernameFilter"], "input", "ALP");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(alpha)\b/)?.[0]), ["alpha"],
    "username filtering must be case-insensitive");

  fire(harness.elements["#adminUsernameFilter"], "input", "");
  fire(harness.elements["#adminScoreSort"], "change", "score-asc");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(alpha|beta|gamma|legacy-one|legacy-two)\b/)?.[0]),
    ["legacy-two", "legacy-one", "alpha", "gamma", "beta"]);

  fire(harness.elements["#adminScoreSort"], "change", "submitted-desc");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(alpha|beta|gamma|legacy-one|legacy-two)\b/)?.[0]),
    ["legacy-one", "alpha", "gamma", "beta", "legacy-two"],
    "latest submission sorting must use submittedAt and retain source order for equal timestamps");

  fire(harness.elements["#adminTeamRecordMode"], "change", "best-per-team");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(beta|gamma|legacy-one|legacy-two)\b/)?.[0]),
    ["legacy-one", "gamma", "beta", "legacy-two"],
    "latest sorting must order the highest-scoring representative selected for each team");
});

test("task filtering and team-best mode keep one highest score per team per task", async () => {
  const records = [
    submittedRecord(1, {
      username: "task1-low", teamName: "同一队伍", taskId: "R2-GYI-MVP-01",
      taskName: "广阳岛综合任务1", score: 71
    }),
    submittedRecord(2, {
      username: "task1-high", teamName: "同一队伍", taskId: "R2-GYI-MVP-01",
      taskName: "广阳岛综合任务1", score: 91
    }),
    submittedRecord(3, {
      username: "task2-low", teamName: "同一队伍", taskId: "R2-GYI-MVP-02",
      taskName: "广阳岛综合任务2", score: 75
    }),
    submittedRecord(4, {
      username: "task2-high", teamName: "同一队伍", taskId: "R2-GYI-MVP-02",
      taskName: "广阳岛综合任务2", score: 95
    })
  ];
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1", records, authoritative: false
  }]);
  await settle();

  fire(harness.elements["#adminTeamRecordMode"], "change", "best-per-team");
  assert.deepEqual(tableRows(harness).map(row => row.match(/task[12]-high/)?.[0]),
    ["task2-high", "task1-high"],
    "one team's best submissions for different tasks must remain separate rows");

  fire(harness.elements["#adminTaskFilter"], "change", "R2-GYI-MVP-01");
  assert.deepEqual(tableRows(harness).map(row => row.match(/task1-high/)?.[0]), ["task1-high"],
    "task filtering must happen before choosing the team's highest score");

  fire(harness.elements["#adminTaskFilter"], "change", "R2-GYI-MVP-02");
  assert.deepEqual(tableRows(harness).map(row => row.match(/task2-high/)?.[0]), ["task2-high"]);
});

test("administrator records distinguish AI autonomy attempts from verified AI closed loops", async () => {
  const records = [
    submittedRecord(1, {
      username: "ai-verified", teamName: "感知队", score: 94,
      autonomyMode: "ai", aiAutonomyVerified: true,
      capabilityUsage: { navigationSensors: true, roadControls: true, vision: true }
    }),
    submittedRecord(2, {
      username: "ai-incomplete", teamName: "探索队", score: 91,
      autonomyMode: "ai", aiAutonomyVerified: false,
      capabilityUsage: { navigationSensors: true, roadControls: false, vision: true }
    }),
    submittedRecord(3, { username: "standard-run", teamName: "常规队", score: 97 })
  ];
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1", records, authoritative: false
  }]);
  await settle();

  assert.equal(harness.elements["#adminMetricAi"].textContent, "2");
  assert.match(tableRows(harness).join(" "), /AI 自主（闭环已验证）/);
  fire(harness.elements["#adminAutonomyModeFilter"], "change", "ai");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\b(ai-verified|ai-incomplete)\b/)?.[0]),
    ["ai-verified", "ai-incomplete"]);
  fire(harness.elements["#adminAutonomyModeFilter"], "change", "ai-verified");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\bai-verified\b/)?.[0]), ["ai-verified"]);
  fire(harness.elements["#adminAutonomyModeFilter"], "change", "standard");
  assert.deepEqual(tableRows(harness).map(row => row.match(/\bstandard-run\b/)?.[0]), ["standard-run"]);
});

test("formal records and user management paginate independently in fixed twenty-row pages", async () => {
  const records = Array.from({ length: 41 }, (_value, index) => paginatedRecord(index + 1));
  const users = Array.from({ length: 25 }, (_value, index) => paginatedAdminUser(index + 1));
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records,
    authoritative: false
  }], { userResponses: [{
    schemaVersion: "chenlong.admin-users/v1",
    users,
    authoritative: false
  }] });
  await settle();

  const pagination = harness.elements["#adminRecordsPagination"];
  const previous = harness.elements["#adminRecordsPrevPage"];
  const next = harness.elements["#adminRecordsNextPage"];
  const range = harness.elements["#adminRecordsRange"];
  const status = harness.elements["#adminRecordsPageStatus"];
  const userPagination = harness.elements["#adminUsersPagination"];
  const userPrevious = harness.elements["#adminUsersPrevPage"];
  const userNext = harness.elements["#adminUsersNextPage"];
  const userRange = harness.elements["#adminUsersRange"];
  const userStatus = harness.elements["#adminUsersPageStatus"];

  assert.equal(pagination.hidden, false);
  assert.equal(tableRows(harness).length, 20);
  assert.match(tableRows(harness)[0], /page-user-01/);
  assert.match(tableRows(harness)[19], /page-user-20/);
  assert.equal(range.textContent, "第 1–20 条，共 41 条");
  assert.equal(status.textContent, "第 1 页，共 3 页");
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, false);
  assert.equal(userPagination.hidden, false);
  assert.equal(userRows(harness).length, 20);
  assert.match(visibleText(userRows(harness)[0]), /account-01/);
  assert.match(visibleText(userRows(harness)[19]), /account-20/);
  assert.equal(userRange.textContent, "第 1–20 条，共 25 条");
  assert.equal(userStatus.textContent, "第 1 页，共 2 页");
  assert.equal(userPrevious.disabled, true);
  assert.equal(userNext.disabled, false);

  click(next);
  assert.equal(tableRows(harness).length, 20);
  assert.match(tableRows(harness)[0], /page-user-21/);
  assert.match(tableRows(harness)[19], /page-user-40/);
  assert.equal(range.textContent, "第 21–40 条，共 41 条");
  assert.equal(status.textContent, "第 2 页，共 3 页");
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, false);
  assert.equal(userStatus.textContent, "第 1 页，共 2 页",
    "turning formal-record pages must not change the user-management page");
  assert.equal(userRows(harness).length, 20);

  click(next);
  assert.equal(tableRows(harness).length, 1);
  assert.match(tableRows(harness)[0], /page-user-41/);
  assert.equal(range.textContent, "第 41–41 条，共 41 条");
  assert.equal(status.textContent, "第 3 页，共 3 页");
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true);
  click(next);
  assert.equal(status.textContent, "第 3 页，共 3 页",
    "the disabled next-page boundary must not advance past the final page");

  click(previous);
  click(previous);
  assert.equal(status.textContent, "第 1 页，共 3 页");
  assert.equal(previous.disabled, true);
  click(previous);
  assert.equal(status.textContent, "第 1 页，共 3 页",
    "the disabled previous-page boundary must not move before page one");
  click(userNext);
  assert.equal(userRows(harness).length, 5);
  assert.match(visibleText(userRows(harness)[0]), /account-21/);
  assert.match(visibleText(userRows(harness)[4]), /account-25/);
  assert.equal(userRange.textContent, "第 21–25 条，共 25 条");
  assert.equal(userStatus.textContent, "第 2 页，共 2 页");
  assert.equal(userPrevious.disabled, false);
  assert.equal(userNext.disabled, true);
  assert.equal(status.textContent, "第 1 页，共 3 页",
    "turning user pages must not change the formal-record page");
});

test("user filtering precedes pagination, resets to page one, and refresh clamps the retained page", async () => {
  const users = count => Array.from({ length: count }, (_value, index) => {
    const isAdministrator = index === 40;
    return {
      ...paginatedAdminUser(index + 1),
      teamName: isAdministrator ? null : `用户队伍 ${index + 1}`,
      group: isAdministrator ? null : (index >= 30 ? "high" : "primary"),
      role: isAdministrator ? "admin" : "user"
    };
  });
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [],
    authoritative: false
  }], { userResponses: [
    { schemaVersion: "chenlong.admin-users/v1", users: users(41), authoritative: false },
    { schemaVersion: "chenlong.admin-users/v1", users: users(21), authoritative: false },
    { schemaVersion: "chenlong.admin-users/v1", users: users(20), authoritative: false }
  ] });
  await settle();

  const previous = harness.elements["#adminUsersPrevPage"];
  const next = harness.elements["#adminUsersNextPage"];
  const range = harness.elements["#adminUsersRange"];
  const status = harness.elements["#adminUsersPageStatus"];
  click(next);
  click(next);
  assert.equal(status.textContent, "第 3 页，共 3 页");

  fire(harness.elements["#adminUserGroupFilter"], "change", "high");
  assert.equal(status.textContent, "第 1 页，共 1 页");
  assert.equal(range.textContent, "第 1–10 条，共 10 条");
  assert.equal(userRows(harness).length, 10);
  assert.match(visibleText(userRows(harness)[0]), /account-31/,
    "the filter must run across every user before selecting the first page");

  for (const [selector, type, value] of [
    ["#adminUserUsernameFilter", "input", "account"],
    ["#adminUserTeamFilter", "input", "用户队伍"],
    ["#adminUserRoleFilter", "change", "user"]
  ]) {
    fire(harness.elements[selector], type, value);
    assert.equal(status.textContent.startsWith("第 1 页"), true, `${selector} must reset the user page`);
    assert.equal(previous.disabled, true);
  }

  fire(harness.elements["#adminUserGroupFilter"], "change", "all");
  fire(harness.elements["#adminUserRoleFilter"], "change", "all");
  fire(harness.elements["#adminUserUsernameFilter"], "input", "");
  fire(harness.elements["#adminUserTeamFilter"], "input", "");
  click(next);
  click(next);
  const refresh = harness.elements["#refreshAdminUsersButton"].listeners.get("click")?.[0];
  assert.ok(refresh);
  await refresh({ target: harness.elements["#refreshAdminUsersButton"] });
  assert.equal(status.textContent, "第 2 页，共 2 页");
  assert.equal(range.textContent, "第 21–21 条，共 21 条");
  assert.equal(userRows(harness).length, 1);
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true);

  await refresh({ target: harness.elements["#refreshAdminUsersButton"] });
  assert.equal(status.textContent, "第 1 页，共 1 页");
  assert.equal(range.textContent, "第 1–20 条，共 20 条");
  assert.equal(userRows(harness).length, 20);
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);
});

test("administrator map editor stays folded, supports keyboard adjustment, and publishes one versioned PUT", async () => {
  const publishedLayout = JSON.parse(JSON.stringify(defaultMapLayout));
  publishedLayout.targets[0][0] = -9.7887;
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [],
    authoritative: false
  }], { mapResponses: [
    mapConfigEnvelope(),
    mapConfigEnvelope({ revision: 1, digest: "b".repeat(64), layout: publishedLayout })
  ] });
  await settle();

  assert.equal(harness.elements["#adminMapEditorBody"].hidden, true,
    "the large editor must remain folded on initial administration load");
  assert.equal(harness.elements["#adminMapVersion"].textContent, "2026.08-source-png-3d.3");
  assert.equal(harness.elements["#adminMapRevision"].textContent, "0");
  assert.equal(harness.elements["#adminMapUpdatedAt"].textContent, "尚未自定义");
  assert.equal(harness.elements["#adminMapMarkers"].children.length, 8);

  click(harness.elements["#toggleAdminMapEditorButton"]);
  assert.equal(harness.elements["#adminMapEditorBody"].hidden, false);
  assert.equal(harness.elements["#toggleAdminMapEditorButton"].attributes.get("aria-expanded"), "true");

  const targetMarker = harness.elements["#adminMapMarkers"].children
    .find(marker => marker.dataset.mapPointKey === "targets-0");
  assert.ok(targetMarker);
  const keydown = targetMarker.listeners.get("keydown")?.[0];
  assert.ok(keydown);
  let prevented = false;
  keydown({ key: "ArrowRight", shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(harness.elements["#saveAdminMapButton"].disabled, false);
  assert.match(harness.elements["#adminMapDraftStatus"].textContent, /尚未发布/);

  click(harness.elements["#saveAdminMapButton"]);
  click(harness.elements["#saveAdminMapButton"]);
  await settle();
  const putRequests = harness.requests.filter(request => (
    request.url === "/api/v1/admin/map-config/R2-GYI-MVP-01/map-01" && request.options.method === "PUT"
  ));
  assert.equal(putRequests.length, 1, "double-clicking save must not publish twice");
  assert.equal(putRequests[0].options.credentials, "same-origin");
  assert.equal(putRequests[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(putRequests[0].options.body), {
    schemaVersion: "chenlong.guangyang-map-config-update/v1",
    baseRevision: 0,
    layout: publishedLayout
  });
  assert.equal(harness.elements["#adminMapRevision"].textContent, "1");
  assert.match(harness.elements["#adminMapVersion"].textContent, /@map-r1-b{12}$/);
  assert.match(harness.elements["#adminMapNotice"].textContent, /已保存并发布/);
  assert.equal(harness.elements["#saveAdminMapButton"].disabled, true);
});

test("administrator sees stable team assignments and can select every configured map variant", async () => {
  const pools = mapPoolsEnvelope();
  pools.assignments = [{
    teamId: `tea_${"1".repeat(32)}`,
    teamName: "地图池测试队",
    members: [{
      userId: `usr_${"2".repeat(32)}`,
      username: "pool-user",
      displayName: "地图池用户"
    }],
    maps: [
      { taskId: "R2-GYI-MVP-01", variantId: "map-03", variantNumber: 3 },
      { taskId: "R2-GYI-MVP-02", variantId: "map-07", variantNumber: 7 },
      { taskId: "R2-GYI-MVP-03", variantId: "map-11", variantNumber: 11 }
    ]
  }];
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [],
    authoritative: false
  }], { mapPoolsResponse: pools });
  await settle();

  assert.equal(harness.elements["#adminMapVariantSelect"].children.length, 8);
  const assignmentText = visibleText(harness.elements["#adminMapAssignmentTableBody"]);
  assert.match(assignmentText, /地图池测试队/);
  assert.match(assignmentText, /pool-user/);
  assert.match(assignmentText, /地图 3/);
  assert.match(assignmentText, /地图 7/);
  assert.match(assignmentText, /地图 11/);

  fire(harness.elements["#adminMapChallengeSelect"], "change", "R2-GYI-MVP-03");
  await settle();
  assert.equal(harness.elements["#adminMapVariantSelect"].children.length, 12);
  fire(harness.elements["#adminMapVariantSelect"], "change", "map-12");
  await settle();
  assert.ok(harness.requests.some(request => (
    request.url === "/api/v1/admin/map-config/R2-GYI-MVP-03/map-12"
  )));
});

test("administrator map editor rejects malformed refreshes and mismatched save receipts without replacing trusted state", async () => {
  const initial = mapConfigEnvelope({ revision: 2, digest: "c".repeat(64) });
  const malformed = { ...mapConfigEnvelope({ revision: 3, digest: "d".repeat(64) }), unexpected: true };
  const mismatchedLayout = JSON.parse(JSON.stringify(defaultMapLayout));
  mismatchedLayout.storage[1] += 0.5;
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [],
    authoritative: false
  }], { mapResponses: [
    initial,
    malformed,
    mapConfigEnvelope({ revision: 3, digest: "e".repeat(64), layout: mismatchedLayout })
  ] });
  await settle();

  click(harness.elements["#refreshAdminMapButton"]);
  await settle();
  assert.equal(harness.elements["#adminMapRevision"].textContent, "2");
  assert.match(harness.elements["#adminMapNotice"].textContent, /页面保留了原有地图和草稿/);

  const targetMarker = harness.elements["#adminMapMarkers"].children
    .find(marker => marker.dataset.mapPointKey === "targets-0");
  targetMarker.listeners.get("keydown")[0]({ key: "ArrowLeft", shiftKey: false, preventDefault() {} });
  click(harness.elements["#saveAdminMapButton"]);
  await settle();
  assert.equal(harness.elements["#adminMapRevision"].textContent, "2",
    "a mismatched success receipt must not advance the trusted revision");
  assert.match(harness.elements["#adminMapNotice"].textContent, /回执与本次操作不一致/);
  assert.equal(harness.elements["#saveAdminMapButton"].disabled, false,
    "the administrator's unpublished draft must remain available after rejection");
});

test("administrator map conflict keeps the unpublished draft and shows a fixed Chinese recovery message", async () => {
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records: [],
    authoritative: false
  }], { mapResponses: [
    mapConfigEnvelope({ revision: 4, digest: "f".repeat(64) }),
    {
      status: 409,
      payload: {
        error: { code: "MAP_CONFIG_REVISION_CONFLICT", message: "published map configuration changed" }
      }
    }
  ] });
  await settle();
  const obstacleMarker = harness.elements["#adminMapMarkers"].children
    .find(marker => marker.dataset.mapPointKey === "obstacles-0");
  obstacleMarker.listeners.get("keydown")[0]({ key: "ArrowDown", shiftKey: true, preventDefault() {} });
  click(harness.elements["#saveAdminMapButton"]);
  await settle();

  assert.equal(harness.elements["#adminMapRevision"].textContent, "4");
  assert.match(harness.elements["#adminMapNotice"].textContent, /地图已被其他管理员更新，请重新加载后再保存/);
  assert.doesNotMatch(harness.elements["#adminMapNotice"].textContent, /published map configuration changed/);
  assert.equal(harness.elements["#saveAdminMapButton"].disabled, false);
});

test("record filtering, team-best selection, and sorting all precede pagination and reset it", async () => {
  const records = Array.from({ length: 45 }, (_value, index) => {
    const recordIndex = index + 1;
    return paginatedRecord(recordIndex, {
      teamName: recordIndex <= 44 ? `shared-team-${Math.ceil(recordIndex / 2)}` : "excluded-team",
      group: recordIndex <= 44 ? "primary" : "high"
    });
  });
  const harness = createHarness([{
    schemaVersion: "chenlong.records/v1",
    records,
    authoritative: false
  }]);
  await settle();

  const previous = harness.elements["#adminRecordsPrevPage"];
  const next = harness.elements["#adminRecordsNextPage"];
  const range = harness.elements["#adminRecordsRange"];
  const status = harness.elements["#adminRecordsPageStatus"];
  const assertFirstPage = message => {
    assert.equal(status.textContent.startsWith("第 1 页"), true, message);
    assert.equal(previous.disabled, true, message);
  };

  click(next);
  fire(harness.elements["#adminGroupFilter"], "change", "primary");
  assertFirstPage("changing a record filter must return to page one");
  assert.equal(range.textContent, "第 1–20 条，共 44 条");

  click(next);
  fire(harness.elements["#adminTeamRecordMode"], "change", "best-per-team");
  assertFirstPage("changing the team record mode must return to page one");
  assert.equal(range.textContent, "第 1–20 条，共 22 条",
    "team-best selection must run across all 44 filtered records before taking a page");

  click(next);
  fire(harness.elements["#adminScoreSort"], "change", "score-asc");
  assertFirstPage("changing record sorting must return to page one");
  assert.equal(tableRows(harness).length, 20);
  assert.match(tableRows(harness)[0], /page-user-43/,
    "the first page must start with the globally lowest selected score, not a re-sorted prior page");
  assert.match(tableRows(harness)[19], /page-user-05/);
  click(next);
  assert.equal(tableRows(harness).length, 2);
  assert.match(tableRows(harness)[0], /page-user-03/);
  assert.match(tableRows(harness)[1], /page-user-01/);
  assert.equal(range.textContent, "第 21–22 条，共 22 条");

  for (const [selector, type, value] of [
    ["#adminUsernameFilter", "input", "page-user"],
    ["#adminTeamFilter", "input", "shared-team"],
    ["#adminStatusFilter", "change", "verified"]
  ]) {
    fire(harness.elements[selector], type, value);
    assertFirstPage(`${selector} must reset formal records to page one`);
    click(next);
  }

  fire(harness.elements["#adminUsernameFilter"], "input", "no-such-user");
  assertFirstPage("an empty filtered result must remain clamped to page one");
  assert.equal(tableRows(harness).length, 1);
  assert.match(tableRows(harness)[0], /没有符合当前筛选条件的记录/);
  assert.equal(range.textContent, "第 0–0 条，共 0 条");
  assert.equal(status.textContent, "第 1 页，共 1 页");
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);
});

test("refreshing formal records clamps the retained page to the new last page", async () => {
  const records = count => Array.from({ length: count }, (_value, index) => paginatedRecord(index + 1));
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: records(41), authoritative: false },
    { schemaVersion: "chenlong.records/v1", records: records(21), authoritative: false },
    { schemaVersion: "chenlong.records/v1", records: records(20), authoritative: false }
  ]);
  await settle();

  const previous = harness.elements["#adminRecordsPrevPage"];
  const next = harness.elements["#adminRecordsNextPage"];
  const range = harness.elements["#adminRecordsRange"];
  const status = harness.elements["#adminRecordsPageStatus"];
  const refresh = harness.elements["#refreshAdminRecordsButton"].listeners.get("click")?.[0];
  assert.ok(refresh);

  click(next);
  click(next);
  assert.equal(status.textContent, "第 3 页，共 3 页");
  await refresh({ target: harness.elements["#refreshAdminRecordsButton"] });
  assert.equal(status.textContent, "第 2 页，共 2 页");
  assert.equal(range.textContent, "第 21–21 条，共 21 条");
  assert.equal(tableRows(harness).length, 1);
  assert.match(tableRows(harness)[0], /page-user-21/);
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true);

  await refresh({ target: harness.elements["#refreshAdminRecordsButton"] });
  assert.equal(status.textContent, "第 1 页，共 1 页");
  assert.equal(range.textContent, "第 1–20 条，共 20 条");
  assert.equal(tableRows(harness).length, 20);
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);
});

test("three-task team summary matches formal records and paginates fifteen registered teams", async () => {
  const users = Array.from({ length: 16 }, (_value, index) => paginatedAdminUser(index + 1));
  const records = [
    submittedRecord(1, { username: "team-one-a", teamName: "用户队伍 1", score: 72 }),
    submittedRecord(2, { username: "team-one-b", teamName: "用户队伍 1", score: 91.5 }),
    submittedRecord(3, { username: "team-one-c", teamName: "用户队伍 1", taskId: "R2-GYI-MVP-02", taskName: "广阳岛综合任务2", score: 83 }),
    submittedRecord(4, { username: "team-sixteen", teamName: "用户队伍 16", taskId: "R2-GYI-MVP-03", taskName: "广阳岛综合任务3", score: 88 })
  ];
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records, authoritative: false }
  ], {
    userResponses: [{ schemaVersion: "chenlong.admin-users/v1", users, authoritative: false }]
  });
  await settle();

  assert.equal(teamScoreRows(harness).length, 15);
  assert.match(teamScoreRows(harness)[0], /用户队伍 1/);
  assert.match(teamScoreRows(harness)[0], /小学组/);
  assert.match(teamScoreRows(harness)[0], /91\.5 \/ 100/);
  assert.match(teamScoreRows(harness)[0], /83\.0 \/ 100/);
  assert.match(teamScoreRows(harness)[0], /174\.5 \/ 300/);
  assert.equal(harness.elements["#adminTeamChallengeBestRange"].textContent, "第 1–15 队，共 16 队");
  assert.equal(harness.elements["#adminTeamChallengeBestPageStatus"].textContent, "第 1 页，共 2 页");

  click(harness.elements["#adminTeamChallengeBestNextPage"]);
  assert.equal(teamScoreRows(harness).length, 1);
  assert.match(teamScoreRows(harness)[0], /用户队伍 16/);
  assert.match(teamScoreRows(harness)[0], /88\.0 \/ 100/);
  assert.match(teamScoreRows(harness)[0], /88\.0 \/ 300/);
  assert.equal(harness.elements["#adminTeamChallengeBestRange"].textContent, "第 16–16 队，共 16 队");
  assert.equal(harness.elements["#adminTeamChallengeBestNextPage"].disabled, true);
});

test("malformed successful administrator data never replaces the last valid table", async () => {
  const valid = submittedRecord(1, { username: "safe-user", teamName: "安全队", score: 88 });
  const malformed = { ...valid, recordState: "saved", submittedAt: null };
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [valid], authoritative: false },
    { schemaVersion: "chenlong.records/v1", records: [malformed], authoritative: false }
  ]);
  await settle();
  const refresh = harness.elements["#refreshAdminRecordsButton"].listeners.get("click")?.[0];
  assert.ok(refresh);
  await refresh({ target: harness.elements["#refreshAdminRecordsButton"] });

  assert.match(tableRows(harness).join(" "), /safe-user/);
  assert.equal(harness.elements["#adminNotice"].dataset.kind, "error");
  assert.match(harness.elements["#adminNotice"].textContent, /已保留上一次成功读取/);
  assert.equal(harness.requests.filter(request => String(request.url).includes("ranked-evaluation")).length, 0,
    "the hidden five-run section must not issue an administrator ranking request");
});

test("administrator records reject unknown or missing account groups", async () => {
  const valid = submittedRecord(1, {
    username: "group-safe-user",
    teamName: "分组安全队",
    group: "primary",
    score: 88
  });
  const unknownGroup = { ...valid, user: { ...valid.user, group: "university" } };
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [valid], authoritative: false },
    { schemaVersion: "chenlong.records/v1", records: [unknownGroup], authoritative: false }
  ]);
  await settle();
  const refresh = harness.elements["#refreshAdminRecordsButton"].listeners.get("click")?.[0];
  assert.ok(refresh);
  await refresh({ target: harness.elements["#refreshAdminRecordsButton"] });

  assert.match(tableRows(harness).join(" "), /group-safe-user/);
  assert.match(tableRows(harness).join(" "), /小学组/);
  assert.equal(harness.elements["#adminNotice"].dataset.kind, "error");
  assert.match(harness.elements["#adminNotice"].textContent, /已保留上一次成功读取/);

  const missingGroup = submittedRecord(2, {
    username: "missing-group-user",
    teamName: "缺失分组队",
    score: 77
  });
  delete missingGroup.user.group;
  const missingHarness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [missingGroup], authoritative: false }
  ]);
  await settle();
  assert.equal(missingHarness.elements["#adminRecordsError"].hidden, false);
  assert.doesNotMatch(tableRows(missingHarness).join(" "), /missing-group-user/);
});

test("administrator records fail closed on malformed capability usage", async () => {
  const valid = submittedRecord(1, {
    username: "capability-safe-user",
    teamName: "能力安全队",
    capabilityUsage: { navigationSensors: true, roadControls: true },
    score: 91
  });
  const malformed = {
    ...valid,
    capabilityUsage: { navigationSensors: true, roadControls: "yes" }
  };
  const harness = createHarness([
    { schemaVersion: "chenlong.records/v1", records: [valid], authoritative: false },
    { schemaVersion: "chenlong.records/v1", records: [malformed], authoritative: false }
  ]);
  await settle();
  assert.match(tableRows(harness).join(" "), /导航传感/);
  assert.match(tableRows(harness).join(" "), /道路控制/);

  const refresh = harness.elements["#refreshAdminRecordsButton"].listeners.get("click")?.[0];
  assert.ok(refresh);
  await refresh({ target: harness.elements["#refreshAdminRecordsButton"] });
  assert.match(tableRows(harness).join(" "), /capability-safe-user/);
  assert.equal(harness.elements["#adminNotice"].dataset.kind, "error");
  assert.match(harness.elements["#adminNotice"].textContent, /已保留上一次成功读取/);
});
