"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDir, "portal.html"), "utf8");
const script = fs.readFileSync(path.join(publicDir, "platform-portal.js"), "utf8");
const loginScript = fs.readFileSync(path.join(publicDir, "platform-login.js"), "utf8");
const adminScript = fs.readFileSync(path.join(publicDir, "platform-admin.js"), "utf8");
const loginHtml = fs.readFileSync(path.join(publicDir, "login.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(publicDir, "admin.html"), "utf8");
const styles = fs.readFileSync(path.join(publicDir, "portal.css"), "utf8");

test("portal presents Python and Blockly as two modes inside one first-question card", () => {
  const firstQuestion = html.match(/<article class="question-card question-card-primary">([\s\S]*?)<\/article>/)?.[1] || "";
  assert.match(firstQuestion, /<span class="question-number">赛题一<\/span>/);
  assert.match(firstQuestion, /class="mode-grid"/);
  assert.match(firstQuestion, /href="\/python\/"/);
  assert.match(firstQuestion, /href="\/blockly\/"/);
  assert.equal((firstQuestion.match(/class="mode-card"/g) || []).length, 2);
  assert.doesNotMatch(html, /\/python\/records\.html|我的记录/);
  assert.doesNotMatch(html, /统一账户、统一队伍，三个编程任务和识物工坊成绩集中查看/);
});

test("workshop portal entry opens the training studio before the submission page", () => {
  const secondQuestion = html.match(/<article class="question-card question-card-secondary">([\s\S]*?)<\/article>/)?.[1] || "";
  assert.match(secondQuestion, /href="\/workshop\/"/);
  assert.doesNotMatch(secondQuestion, /href="\/workshop\/competition"/);
  assert.match(loginScript, /requestedReturnTo === "\/workshop\/"/);
});

test("registration and administration expose exactly the three competition groups", () => {
  for (const source of [loginHtml, adminHtml]) {
    assert.match(source, /value="primary">小学组</u);
    assert.match(source, /value="junior">初中组</u);
    assert.match(source, /value="high">高中组</u);
    assert.doesNotMatch(source, /primary_low|primary_high|1-3年级|4-6年级/u);
  }
  assert.match(script, /primary:\s*"小学组"/u);
  assert.match(adminScript, /primary:\s*"小学组"/u);
});

test("all unified entry pages declare the existing SVG favicon", () => {
  for (const source of [html, loginHtml, adminHtml]) {
    assert.match(source, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  }
});

test("invite dialog has script-bound close controls and no CSP-blocked inline handler", () => {
  assert.match(html, /id="closeInviteButton"[^>]*type="button"/);
  assert.match(html, /id="closeInviteFooterButton"[^>]*type="button"/);
  assert.match(html, /id="copyInviteButton"[^>]*disabled/);
  assert.doesNotMatch(html, /\son(?:click|submit|close)=/i);
  assert.match(script, /#closeInviteButton"\)\.addEventListener\("click", closeInviteDialog\)/);
  assert.match(script, /#closeInviteFooterButton"\)\.addEventListener\("click", closeInviteDialog\)/);
  assert.match(script, /event\.target === inviteDialog/);
  assert.match(script, /navigator\.clipboard/);
});

test("portal styling keeps grouped cards responsive and respects reduced motion", () => {
  assert.match(styles, /\.question-grid\s*\{/);
  assert.match(styles, /\.mode-grid\s*\{/);
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /@media \(max-width: 650px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("admin redraws every visible member after a team-wide user update", () => {
  assert.match(
    adminScript,
    /users\.forEach\([\s\S]*?user\.group = newGroup;\s*renderUsers\(\);\s*await loadScores/u,
  );
});

test("admin total-score table filters groups through the paginated server endpoint", () => {
  const scorePanel = adminHtml.match(/id="scorePanel"[\s\S]*?id="userPanel"/)?.[0] || "";
  assert.match(scorePanel, /id="scoreGroupFilter"/);
  assert.match(scorePanel, /value="">全部分组/);
  assert.match(scorePanel, /value="primary">小学组/);
  assert.match(scorePanel, /value="junior">初中组/);
  assert.match(scorePanel, /value="high">高中组/);
  assert.match(adminScript, /query\.set\("group", scoreGroup\)/);
  assert.match(adminScript, /#scoreGroupFilter"\)\.addEventListener\("change"/);
  assert.match(adminScript, /scorePage = 1;\s*loadScores\(\)/);
});

test("unified admin system tab displays aggregate readiness and deployment configuration", () => {
  assert.match(adminHtml, /id="readinessServices"/);
  assert.match(adminHtml, /id="readinessConfiguration"/);
  assert.match(adminHtml, /id="evaluationSetReadiness"/);
  assert.match(adminHtml, /id="refreshReadiness"/);
  assert.match(adminScript, /fetch\("\/api\/readiness"/);
  assert.match(adminScript, /payload\.schemaVersion !== "chenlong\.competition-platform-readiness\/v1"/);
  assert.match(adminScript, /officialSsoConfigured/);
  assert.match(adminScript, /trustedProxyConfigured/);
  assert.match(adminScript, /publicOriginConfigured/);
  assert.match(adminScript, /renderEvaluationSetReadiness\(payload\.evaluationSets\)/);
  assert.match(adminScript, /请进入识物工坊后台上传真实评测集/);
});
