"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "tools", "browser-e2e.js"), "utf8");

test("browser acceptance uses an isolated e2e account and covers every toolbox entry", () => {
  assert.match(source, /const username = `e2e_\$\{stamp\}`/);
  assert.doesNotMatch(source, /const username = `(?:ui|test|accept)_/);
  assert.match(source, /assert\.equal\(toolboxMatrix\.length, 80/);
  assert.match(source, /assert\.equal\(new Set\(toolboxMatrix\.map\(item => item\.type\)\)\.size, 73/);
  assert.match(source, /const DYNAMIC_BLOCK_TYPES = Object\.freeze\(\[[\s\S]*?variables_get[\s\S]*?procedures_ifreturn/);
  assert.match(source, /Blockly\.Xml\.domToBlock\(template\.cloneNode\(true\), workspace\)/);
  assert.match(source, /new AsyncFunction\("robot", source\)/);
  assert.match(source, /workspaceBlockCount: workspace\.getAllBlocks\(false\)\.length/);
});

test("browser acceptance safely runs all fourteen categories and validates persistence", () => {
  for (const category of [
    "小车移动", "物品操作", "顺序与选择", "循环", "基础传感", "导航传感", "道路控制",
    "摄像头感知", "数据与列表", "等待与输出", "数学与逻辑", "文本", "变量", "函数"
  ]) {
    assert.match(source, new RegExp(`"${category}"`));
  }
  assert.match(source, /for \(const categoryName of RUNTIME_CATEGORY_NAMES\.filter\(name => name !== "函数"\)\)/);
  assert.match(source, /runtimeResults\.push\(await runAndSubmitCurrentProgram\(categoryName\)\)/);
  assert.match(source, /runtimeResults\.push\(await runAndSubmitCurrentProgram\("函数"\)\)/);
  assert.match(source, /assert\.deepEqual\(runtimeResults\.map\(item => item\.categoryName\), RUNTIME_CATEGORY_NAMES\)/);
  assert.match(source, /record\.recordState, "saved"/);
  assert.match(source, /本次调试已保存/);
  assert.match(source, /\/submit'/);
  assert.match(source, /document\.querySelector\('#adminRecordCount'\)\.textContent === '16'/);
  assert.match(source, /adminRecordProgramCode/);
  assert.match(source, /adminRecordCapabilities/);
});
