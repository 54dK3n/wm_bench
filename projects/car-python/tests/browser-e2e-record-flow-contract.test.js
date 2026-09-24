"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const toolSource = fs.readFileSync(path.join(root, "tools", "browser-e2e.js"), "utf8");

function functionSource(name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\(`);
  const start = toolSource.search(declaration);
  assert.ok(start >= 0, `missing browser E2E helper ${name}`);
  const remaining = toolSource.slice(start + 1);
  const next = remaining.search(/\n(?:async\s+)?function\s+/);
  return toolSource.slice(start, next < 0 ? toolSource.length : start + 1 + next);
}

test("the first registered administrator lands in the backend before using its workspace navigation", () => {
  const flow = functionSource("registerAndEnter");
  assert.match(flow, /#teamInviteDialog/);
  assert.match(flow, /#teamInviteCodeValue/);
  assert.match(flow, /#teamInviteContinueButton/);
  assert.ok(flow.indexOf('await page.click("#teamInviteContinueButton")')
    < flow.indexOf('location.pathname !== "/admin.html"'),
  "the smoke must acknowledge the new-team invitation before checking the administrator landing");
  assert.match(flow, /location\.pathname !== "\/admin\.html"/);
  for (const selector of [
    "#adminUsernameFilter",
    "#adminTeamFilter",
    "#adminScoreSort",
    "#adminTeamRecordMode",
    "#refreshAdminRecordsButton"
  ]) {
    assert.ok(flow.includes(`document.querySelector("${selector}")`),
      `administrator landing assertion is missing ${selector}`);
  }
  assert.match(flow, /adminLanding\.role, \/管理员\//);
  assert.match(flow, /await page\.click\('\.portal-nav a\[href="\.\/"\]'\)/);
  assert.match(flow, /location\.pathname === "\/" && Boolean\(document\.querySelector\("#simCanvas"\)\)/);
  assert.ok(flow.indexOf('location.pathname !== "/admin.html"')
    < flow.indexOf("await page.click('.portal-nav"),
  "the smoke must assert the administrator backend before navigating to the workspace");
});

test("standard and Guangyang smoke runs auto-save exactly one draft without a formal submission", () => {
  const flow = functionSource("assertAutoSavedDraftWithoutFormalSubmission");
  const main = functionSource("main");
  assert.match(flow, /draftSaveRequests\(diagnostics, requestStartIndex\)/);
  assert.match(flow, /assert\.equal\(drafts\.length, 1/);
  assert.match(flow, /submissionRequests\(diagnostics, requestStartIndex\)\.length/);
  assert.match(flow, /recordSubmitRequests\(diagnostics, requestStartIndex\)\.length/);
  assert.match(flow, /savedRecord\.recordState, "saved"/);
  assert.match(flow, /savedRecord\.submissionId, null/);
  assert.match(main, /const savedDraft = await assertAutoSavedDraftWithoutFormalSubmission\(/);
  assert.match(main, /await openWorkspaceRecordsAndSubmitSavedRow\(/);
  assert.doesNotMatch(main, /assertPendingUntilExplicitSubmit|openRecordsDialogAndSubmit|openWorkspaceRecordsThenSubmitOnRecordsPage/);
});

test("Guangyang browser acceptance routes emit only the public one-argument centimeter drive API", () => {
  for (const name of ["guangyangRouteProgram", "guangyangRecoveryProgram"]) {
    const source = functionSource(name);
    assert.match(source, /robot\.forward\(\$\{action\.distanceCm\.toFixed\(4\)\}\)/,
      `${name} does not convert its validated world displacement to centimeters`);
    assert.doesNotMatch(source, /robot\.forward\([^\n]*action\.seconds[^\n]*action\.speedPercent/,
      `${name} still emits the removed two-argument timed drive API`);
  }
});

test("standard browser smoke rejects a second Guangyang map PNG GET when run is clicked", () => {
  const counter = functionSource("guangyangMapGetRequests");
  const flow = functionSource("runCompetition");
  const main = functionSource("main");

  assert.match(toolSource, /const GUANGYANG_MAP_PATHNAME\s*=\s*"\/word\/广阳岛仿真沙盘地图\.png"/);
  assert.match(counter, /diagnostics\.requests\.slice\(startIndex\)/);
  assert.match(counter, /entry\.method\s*!==\s*"GET"/);
  assert.match(counter, /decodeURIComponent\(new URL\(entry\.url\)\.pathname\)\s*===\s*GUANGYANG_MAP_PATHNAME/);

  const readyIndex = flow.indexOf('"首次广阳岛地图纹理加载完成"');
  const cursorIndex = flow.indexOf("const mapRequestStartIndex = diagnostics.requests.length");
  const clickIndex = flow.indexOf('await page.click("#runButton")');
  const finishedIndex = flow.indexOf("const finished = await page.waitForValue");
  const assertionIndex = flow.indexOf("assert.equal(repeatedMapRequests.length, 0");
  assert.ok(readyIndex >= 0 && readyIndex < cursorIndex && cursorIndex < clickIndex,
    "the request cursor must be captured only after the first map texture succeeds and before the real click");
  assert.ok(finishedIndex > clickIndex && assertionIndex > finishedIndex,
    "the no-second-GET assertion must run after the clicked program finishes");
  assert.match(flow, /guangyangFlatMapPlane[\s\S]*flatMap\?\.material\?\.map/);
  assert.match(flow, /guangyangTerrainMesh[\s\S]*terrain\?\.parent/);
  assert.match(flow, /guangyangMapGetRequests\(diagnostics, mapRequestStartIndex\)/);
  assert.match(main, /runCompetition\(page, diagnostics\)/);
});

test("record actions are reached by expanding the default-collapsed live evaluation UI", () => {
  const helper = functionSource("expandCompetitionHudForRecordActions");
  const main = functionSource("main");
  assert.match(helper, /initial\.expanded, "false"/);
  assert.match(helper, /await page\.click\("#competitionHudToggle"\)/);
  assert.match(helper, /getAttribute\("aria-expanded"\) !== "true"/);
  for (const selector of [
    "#replayRunRecordButton",
    "#exportRunRecordButton",
    "#verifyRunRecordButton"
  ]) {
    assert.ok(helper.includes(selector), `expanded live evaluation assertion is missing ${selector}`);
  }
  const expandIndex = main.indexOf("await expandCompetitionHudForRecordActions(page)");
  const replayIndex = main.indexOf("await replayCurrentRecord(page");
  const exportIndex = main.indexOf("await exportRecord(page");
  const verifyIndex = main.indexOf("await verifyRecord(page");
  assert.ok(expandIndex >= 0 && expandIndex < replayIndex && expandIndex < exportIndex && expandIndex < verifyIndex,
    "the live evaluation details must be expanded before replay, export, or verification");
});

test("camera practice smoke uses the current recognition-practice mission titles", () => {
  for (const title of [
    "广阳岛识别练习：目标物投放",
    "广阳岛识别练习：障碍物绕行",
    "广阳岛识别练习：混淆物移出道路"
  ]) {
    assert.equal(toolSource.split(title).length - 1, 2,
      `browser E2E must use the current title in both direct and built-in practice checks: ${title}`);
  }
  assert.doesNotMatch(toolSource, /广阳岛训练：(?:目标物投放|障碍物绕行|混淆物移出道路)/);
});

test("browser smoke submits only the visible matching row in the workspace records dialog", () => {
  const flow = functionSource("openWorkspaceRecordsAndSubmitSavedRow");
  assert.match(flow, /await page\.click\("#recordsNavLink"\)/);
  assert.match(flow, /record\?\.querySelector\("\.workspace-record-submit"\)/);
  assert.match(flow, /opened\.rowSubmitVisible, true/);
  assert.match(flow, /opened\.legacyHudSubmitVisible, false/);
  assert.match(flow, /opened\.legacyCurrentSubmitVisible, false/);
  assert.match(flow, /#competitionRecordsList \[data-record-id=/);
  assert.match(flow, /\.workspace-record-submit/);
  assert.match(flow, /recordSubmitRequests\(diagnostics, requestStartIndex\)/);
  assert.match(flow, /posts\.length, 1/);
  assert.match(flow, /`\/api\/v1\/records\/\$\{savedDraft\.id\}\/submit`/);
  assert.match(flow, /summary\.body\.records\[0\]\.recordState, "submitted"/);
  assert.doesNotMatch(flow, /page\.click\("#submitPendingRunRecordButton"\)/);
  assert.doesNotMatch(flow, /page\.navigate\([^)]*recordsPageHref/);
});

test("workspace record submission and archived replay preserve the editor source", () => {
  const submitFlow = functionSource("openWorkspaceRecordsAndSubmitSavedRow");
  const replayFlow = functionSource("replayArchivedRecordAfterReload");
  assert.match(submitFlow, /closed\.editorSource, editorSource/);
  assert.match(replayFlow, /expectedEditorSource = null/);
  assert.match(replayFlow, /await page\.reload\(30_000\)/);
  assert.match(replayFlow, /initialState\.editorSource, expectedEditorSource/);
  assert.ok(replayFlow.includes("/\\/api\\/v1\\/records\\?limit=1$/"));
  assert.ok(replayFlow.includes("/\\/api\\/v1\\/records\\/sub_[a-f0-9]{32}\\/run-record$/"));
});
