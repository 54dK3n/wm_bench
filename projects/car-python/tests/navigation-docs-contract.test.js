const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const core = require("../competition-core.js");
const documents = [
  ["README", fs.readFileSync(path.join(root, "README.md"), "utf8")],
  ["开发说明", fs.readFileSync(path.join(root, "docs", "广阳岛仿真系统开发说明.md"), "utf8")]
];

const stoppedByValues = [
  "max_distance", "junction", "road_end", "front_clearance", "entered_road",
  "off_road", "wrong_way", "not_at_junction", "invalid_exit",
  "collision", "safety_limit", "time_limit"
];

test("navigation control documentation matches the frozen local-control contract", () => {
  assert.equal(core.NAVIGATION_CONTROL_DEFINITION.schemaVersion, "chenlong.navigation-control/v8");
  assert.equal(core.NAVIGATION_CONTROL_DEFINITION.actionLimit, 300);
  assert.deepEqual(Object.keys(core.NAVIGATION_CONTROL_DEFINITION.methods), ["follow_road", "take_exit"]);

  for (const [label, document] of documents) {
    assert.match(document, /mission\(\)[\s\S]*roadId[\s\S]*progressCm/, `${label}: public task anchors`);
    assert.match(document, /task_state\(\)[\s\S]*(?:任务进度|任务引擎)/, `${label}: verified task progress`);
    assert.match(document, /(?:目标物|混淆物|障碍物|任务物体)[^\n]*(?:roadId|道路级|progressCm)/,
      `${label}: ordinary single sessions document object road anchors`);
    assert.match(document, /不(?:包含|返回)[^\n]*(?:世界坐标|绝对坐标|预落点坐标)/,
      `${label}: task semantics must not expose world coordinates`);
    assert.match(document, /follow_road\(max_cm=100,\s*speed=40,\s*obey_speed_limit=False\)/,
      `${label}: follow_road signature`);
    assert.match(document, /obey_speed_limit=True[\s\S]*(?:限速|钳制)/, `${label}: opt-in speed-limit following`);
    assert.match(document, /take_exit\(road_id,\s*speed=30,\s*obey_speed_limit=False\)/,
      `${label}: take_exit signature`);
    assert.match(document, /10[～-]500[^\n]*厘米/, `${label}: follow distance bounds`);
    assert.match(document, /speed[^\n]*10[～-]100/, `${label}: speed bounds`);
    assert.match(document, /road_state\(\)\["exits"\]/, `${label}: contestant-selected exit source`);
    assert.match(document, /最多\s*300\s*次/, `${label}: independent action budget`);
    assert.match(document, /1,000\s*次[^\n]*预算[^\n]*独立|1,000\s*次预算[^\n]*相互独立/,
      `${label}: query/control budgets are independent`);
    assert.match(document, /不是自动寻路|不会[^\n]*(?:自动寻路|规划路线)/, `${label}: no route planner claim`);
    assert.match(document, /路线搜索[^\n]*出口(?:选择|决策)[^\n]*(?:学生|参赛程序)/,
      `${label}: route decisions remain contestant-owned`);

    const resultStart = document.indexOf("两个方法");
    assert.ok(resultStart >= 0, `${label}: shared result contract section`);
    const resultSection = document.slice(resultStart, resultStart + 5000);
    const positions = core.NAVIGATION_CONTROL_DEFINITION.methods.follow_road.resultFields
      .map(field => resultSection.indexOf(`\`${field}\``));
    assert.ok(positions.every(position => position >= 0), `${label}: all result fields are documented`);
    assert.deepEqual([...positions].sort((left, right) => left - right), positions,
      `${label}: result fields use the frozen order`);
    stoppedByValues.forEach(value => assert.match(document, new RegExp(`\\b${value}\\b`),
      `${label}: missing stoppedBy value ${value}`));
  }
});
