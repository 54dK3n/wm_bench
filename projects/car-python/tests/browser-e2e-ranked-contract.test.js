"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const toolSource = fs.readFileSync(path.join(root, "tools", "browser-e2e.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("package exposes an isolated real-Chrome ranked five-slot smoke mode", () => {
  assert.equal(packageJson.scripts["test:e2e:ranked"], "node tools/browser-e2e.js --ranked-smoke");
  assert.match(toolSource, /const RANKED_SMOKE_MODE = process\.argv\.includes\("--ranked-smoke"\)/);
  assert.match(toolSource, /if \(RANKED_SMOKE_MODE\) \{[\s\S]*runRankedEvaluationSmoke/);
  assert.match(toolSource, /RANKED_SMOKE_MODE\][\s\S]*\.filter\(Boolean\)\.length > 1/);
});

test("ranked smoke source is deliberately short and coordinate-independent", () => {
  const declaration = /const RANKED_SMOKE_SOURCE = \[([\s\S]*?)\]\.join\("\\n"\);/
    .exec(toolSource)?.[1] || "";
  assert.match(declaration, /robot\.odometry\(\)/);
  assert.doesNotMatch(
    declaration,
    /robot\.(?:forward|backward|left_angle|right_angle|follow_road|take_exit|approach|grab|release)\s*\(/
  );
  assert.doesNotMatch(declaration, /(?:layout|anchor|worldX|worldZ|position|\bx\b|\bz\b)/i);
});

test("ranked smoke requires two real UI clicks before any attempt is created", () => {
  assert.match(toolSource, /await page\.click\("#startRankedEvaluationButton"\)/);
  assert.match(toolSource, /#rankedEvaluationConfirmDialog/);
  assert.match(toolSource, /pendingRankedEvaluationConfirmation/);
  assert.match(toolSource, /assert\.deepEqual\(await readRankedFetchProbe\(page\), \[\]/);
  assert.match(toolSource, /await page\.click\("#confirmRankedEvaluationButton"\)/);
  assert.match(toolSource, /__chenlongRankedStartClickCount/);
  assert.match(toolSource, /__chenlongRankedConfirmClickCount/);
  assert.match(toolSource, /__chenlongRankedOrdinaryRunClickCount/);
});

test("ranked smoke pins five serial leases and five ranked-only submissions", () => {
  for (const required of [
    "assertRankedMainTraffic",
    "assertRankedCdpMainTraffic",
    "assertRankedNoFallbackPosts",
    "recordIdentity",
    "sourceCode: source",
    "Array(5).fill(\"valid\")",
    "70% 均分 + 30% 最低分",
    "ordinarySubmissionReceipt"
  ]) {
    assert.ok(toolSource.includes(required), `ranked browser contract is missing ${required}`);
  }
  assert.match(toolSource, /\/current-slot\\\/lease\$\/\.test\(item\.path\)\)\.length, 5/);
  assert.match(toolSource, /\/slots\\\/\[1-5\]\\\/sessions\\\/ses_\[a-f0-9\]\{32\}\\\/submissions\$\/\.test\(item\.path\)\)\.length, 5/);
  assert.match(toolSource, /item\.path === "\/api\/v1\/sessions"\)\.length, 0/);
  assert.match(toolSource, /item\.path\.startsWith\("\/api\/v1\/evaluation-batches"\)\)\.length, 0/);
});

test("ranked smoke asserts current-layout-only delivery and leaderboard privacy", () => {
  for (const required of [
    "assertRankedLayoutBoundary",
    "futureLayouts",
    "privateLayoutSelection",
    "privateLayoutSequence",
    "layoutCatalog",
    "必须且只能下发当前一局运行定义",
    "同时包含多局布局承诺",
    "assertAnonymousRankedRanking",
    "assertAdminRankedRanking",
    "RANKED_ATTEMPT_ALREADY_EXISTS"
  ]) {
    assert.ok(toolSource.includes(required), `ranked privacy contract is missing ${required}`);
  }
  assert.match(toolSource, /assert\.equal\(runDefinitionCount, 1/);
  assert.match(toolSource, /assert\.equal\(interactionDefinitionCount, 1/);
  assert.match(toolSource, /assert\.equal\(entry\.participant\?\.username, credentials\.username\)/);
  assert.match(toolSource, /assert\.equal\(entry\.teamId, RANKED_SMOKE_TEAM_ID\)/);
  assert.match(toolSource, /"participant", "ownerUserId", "username", "teamId", "lockedTeamId"/);
  assert.match(toolSource, /"anonymousParticipantId", "quality", "rank", "ranking", "score"/);
  assert.match(toolSource, /payload\?\.competition\?\.displayName, "筛选五局（本地参考）"/);
});

test("ranked smoke reloads a finalized owner without overwriting the new draft", () => {
  assert.match(toolSource, /async function testRankedFinalizedReload/);
  assert.match(toolSource, /await page\.fill\("#pythonEditor", RANKED_CONFLICT_SOURCE\)/);
  assert.match(toolSource, /await page\.reload\(30_000\)/);
  assert.match(toolSource, /完成用户刷新意外覆盖了已开始的新源码草稿/);
  assert.match(toolSource, /assert\.equal\(restored\.expiresAt, run\.traffic\.expiresAt/);
  assert.match(toolSource, /await waitForPython\(page\);[\s\S]*await delay\(1_000\)/);
  assert.match(toolSource, /assert\.equal\(pairs\.length, 1, "完成用户刷新只能读取一次筛选 \/me"\)/);
  assert.match(toolSource, /assert\.equal\(restored\.running, false/);
  assert.match(toolSource, /assert\.equal\(restored\.operationActive, false/);
});

test("ranked smoke creates a separate open owner and restores it without leasing or running", () => {
  assert.match(toolSource, /async function testRankedOpenOwnerRecovery/);
  assert.match(toolSource, /fetch\("\/api\/v1\/auth\/register"/);
  assert.match(toolSource, /source: \$\{JSON\.stringify\(RANKED_RECOVERY_SOURCE\)\}/);
  assert.match(toolSource, /sessionStorage\.clear\(\)/);
  assert.match(toolSource, /active\?\.batch\?\.phase !== "open" \|\| active\?\.uiState !== "recovery"/);
  assert.match(toolSource, /assert\.equal\(restored\.editorSource, RANKED_RECOVERY_SOURCE/);
  assert.match(toolSource, /assert\.equal\(restored\.editorReadOnly, true/);
  assert.match(toolSource, /assert\.equal\(restored\.teamInput, RANKED_RECOVERY_TEAM_ID/);
  assert.match(toolSource, /assert\.equal\(recoveryPairs\.length, 1, "open 筛选刷新只能读取一次 \/me"\)/);
  assert.match(toolSource, /open 筛选刷新自动领取了当前局租约/);
  assert.match(toolSource, /open 筛选刷新自动提交了运行记录/);
});
