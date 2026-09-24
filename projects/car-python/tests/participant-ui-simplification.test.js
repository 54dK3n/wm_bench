"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

test("participant page exposes only the single-run scoring workflow", () => {
  for (const id of ["rankedEvaluationPanel", "competitionBatchPanel"]) {
    assert.match(
      html,
      new RegExp(`id=["']${id}["'][^>]*\\bhidden\\b[^>]*\\binert\\b[^>]*aria-hidden=["']true["']`)
    );
  }
  assert.match(styles, /\.five-run-evaluation-ui\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(app, /const FIVE_RUN_EVALUATION_UI_ENABLED\s*=\s*false/);
  assert.match(
    app,
    /if\s*\(FIVE_RUN_EVALUATION_UI_ENABLED\)\s*\{[\s\S]*restoreRankedEvaluationFromServer\(\)[\s\S]*restoreCompetitionBatchFromPage\(\)/
  );
  assert.match(app, /const active\s*=\s*fiveRunUiEnabled\s*&&/);
});

test("obsolete manual-submit surfaces stay hidden while record viewing remains available", () => {
  assert.match(html, /id=["']submitRunRecordButton["'][^>]*\bhidden\b[^>]*\binert\b/);
  assert.match(html, /id=["']pendingCompetitionRecord["'][^>]*\bhidden\b[^>]*\binert\b/);
  assert.match(html, /id=["']competitionRecordsListTitle["']>运行记录</);
  assert.match(html, /每次运行结束后都会自动记在这里/);
  assert.match(styles, /\.legacy-manual-submit,[\s\S]*\.legacy-pending-record\s*\{[^}]*display:\s*none\s*!important/s);
});

test("Guangyang objects have readable scene names without a persistent object legend", () => {
  assert.doesNotMatch(html, /id=["']guangyangObjectGuide["']|>场景对象</);
  assert.doesNotMatch(styles, /guangyang-object-guide/);
  assert.match(app, /attachObjectNameLabel\(group,\s*["']障碍物["']/);
  assert.match(app, /attachObjectNameLabel\(group,\s*trainingVisionCategoryLabel\(category\)/);
  assert.match(app, /label\.userData\.hideFromVirtualCamera\s*=\s*true/);
});

test("camera practice explains the complete observe-to-action learning loop", () => {
  assert.match(html, /摄像头识别练习/);
  assert.match(html, /不是训练识别模型/);
  assert.match(html, /observe[\s\S]*类别、方向、距离和置信度[\s\S]*编写小车动作[\s\S]*识别框和练习反馈/);
  assert.match(html, /不会改变模型、识别参数或比赛评分/);
  assert.match(html, /车载摄像头识别结果/);
});
