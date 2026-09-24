const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const guide = fs.readFileSync(path.join(root, "指导书.md"), "utf8");
const three = fs.readFileSync(path.join(root, "vendor", "three", "three.min.js"), "utf8");
const toolbox = html.match(/<xml id="toolbox"[\s\S]*?<\/xml>/)?.[0] || "";

test("toolbox exposes the Python-level Blockly block catalog", () => {
  for (const category of [
    "小车移动",
    "物品操作",
    "顺序与选择",
    "循环",
    "基础传感",
    "导航传感",
    "道路控制",
    "摄像头感知",
    "数据与列表",
    "等待与输出",
    "数学与逻辑",
    "文本",
    "变量",
    "函数"
  ]) {
    assert.match(toolbox, new RegExp(`<category name="${category}"`));
  }

  for (const type of [
    "robot_move_cm",
    "robot_gripper",
    "robot_sequence",
    "controls_if",
    "controls_repeat_ext",
    "controls_whileUntil",
    "controls_for",
    "controls_forEach",
    "robot_forever",
    "robot_front_blocked",
    "robot_sensor_distance",
    "robot_on_road",
    "robot_holding_package",
    "robot_checkpoint_count",
    "robot_task_complete",
    "robot_mission",
    "robot_task_state",
    "robot_release_preview",
    "robot_odometry",
    "robot_road_state",
    "robot_map_graph",
    "robot_follow_road",
    "robot_take_exit",
    "robot_vision_observe",
    "robot_vision_detect",
    "robot_vision_approach",
    "robot_data_get",
    "robot_list_item",
    "robot_data_length",
    "text_print",
    "math_arithmetic",
    "logic_compare",
    "logic_operation"
  ]) {
    assert.match(toolbox, new RegExp(`<block type="${type}"`));
  }
});

test("centimeter movement is the default while saved second-based blocks remain compatible", () => {
  assert.match(app, /Blockly\.Blocks\.robot_move_cm\s*=\s*\{/);
  assert.match(app, /Blockly\.JavaScript\.robot_move_cm[\s\S]*?return `await robot\.\$\{dir\}\(\$\{distanceCm\}\);\\n`;/);
  assert.match(app, /function createStarterProgram\(\)[\s\S]*?makeMoveCmBlock\("forward", 50\)/);
  assert.match(app, /forward:\s*distanceCm\s*=>\s*moveRobotCentimeters\(1, distanceCm, context\)/);
  assert.match(app, /backward:\s*distanceCm\s*=>\s*moveRobotCentimeters\(-1, distanceCm, context\)/);

  assert.match(app, /Blockly\.Blocks\.robot_move\s*=\s*\{/);
  assert.match(app, /forwardSeconds:\s*seconds\s*=>\s*moveRobot\(1, seconds, context\)/);
  assert.match(app, /backwardSeconds:\s*seconds\s*=>\s*moveRobot\(-1, seconds, context\)/);
  assert.doesNotMatch(toolbox, /<block type="robot_move">/);
});

test("sensor, task-state, sequence, gripper, output and safe-loop APIs are wired", () => {
  assert.match(app, /defineRobotBooleanBlock\("robot_front_blocked"[^\n]+"checkFrontObstacle"/);
  assert.match(app, /defineRobotBooleanBlock\("robot_on_road"[^\n]+"onRoad"/);
  assert.match(app, /defineRobotBooleanBlock\("robot_holding_package"[^\n]+"holding"/);
  assert.match(app, /defineRobotBooleanBlock\("robot_task_complete"[^\n]+"taskComplete"/);
  assert.match(app, /Blockly\.JavaScript\.robot_sensor_distance\s*=\s*\(\)\s*=>\s*\["robot\.distance\(\)"/);
  assert.match(app, /Blockly\.JavaScript\.robot_checkpoint_count\s*=\s*\(\)\s*=>\s*\["robot\.checkpointCount\(\)"/);
  assert.match(app, /Blockly\.JavaScript\.robot_sequence[\s\S]*?statementToCode\(block, "DO"\)/);
  assert.match(app, /Blockly\.JavaScript\.robot_gripper[\s\S]*?`await robot\.\$\{action\}\(\);\\n`/);
  assert.match(app, /Blockly\.JavaScript\.text_print[\s\S]*?`await robot\.print\(\$\{value\}\);\\n`/);
  assert.match(app, /const MAX_PROGRAM_LOOP_ITERATIONS = 100/);
  assert.match(app, /Blockly\.JavaScript\.robot_forever[\s\S]*?robot\.loopTick\("持续巡逻"/);
  assert.match(app, /function defineSafeLoopGenerators\(/);
  assert.match(app, /readBlocklyNavigationSensor\(context, "mission"\)/);
  assert.match(app, /followBlocklyRoad\(context, maxCm, speed, obeySpeedLimit\)/);
  assert.match(app, /takeBlocklyExit\(context, roadId, speed, obeySpeedLimit\)/);
  assert.match(app, /queryBlocklyVision\(context, "observe", target, confidence\)/);
  assert.match(app, /executionTrace: Array\.isArray\(context\?\.executedApiMethods\)/);
});

test("the 40 by 24 world consistently converts to 500 by 300 centimeters", () => {
  const unitsPerMeter = Number(app.match(/const PRIMARY_WORLD_UNITS_PER_METER = ([\d.]+);/)?.[1]);
  assert.equal(unitsPerMeter, 8);
  const centimetersPerWorldUnit = 100 / unitsPerMeter;
  assert.equal(centimetersPerWorldUnit, 12.5);
  assert.equal(40 * centimetersPerWorldUnit, 500);
  assert.equal(24 * centimetersPerWorldUnit, 300);

  assert.match(app, /const PRIMARY_CM_PER_WORLD_UNIT = 100 \/ PRIMARY_WORLD_UNITS_PER_METER/);
  assert.match(app, /function primaryWorldUnitsToCm\(value\)[\s\S]*?Number\(value\) \* PRIMARY_CM_PER_WORLD_UNIT/);
  assert.match(app, /function primaryCmToWorldUnits\(value\)[\s\S]*?Number\(value\) \/ PRIMARY_CM_PER_WORLD_UNIT/);
  assert.match(app, /const seconds = primaryCmToWorldUnits\(centimeters\) \/ PRIMARY_DRIVE_WORLD_UNITS_PER_SECOND/);
  assert.match(app, /distance:\s*\(\)\s*=>\s*Math\.round\(primaryWorldUnitsToCm\(frontDistance\(\)\)\)/);
  assert.match(app, /primaryWorldUnitsToCm\(reach\.side\)/);
  assert.match(app, /primaryWorldUnitsToCm\(reach\.forward\)/);
  assert.match(app, /const xCm = primaryWorldUnitsToCm\(robotPose\.x\)/);
  assert.match(app, /const zCm = primaryWorldUnitsToCm\(robotPose\.z\)/);
  assert.match(app, /`\$\{xCm\.toFixed\(1\)\}, \$\{zCm\.toFixed\(1\)\} cm`/);
  assert.doesNotMatch(app, /frontDistance\(\)\s*\*\s*100/);
  assert.doesNotMatch(app, /reach\.(?:side|forward)\s*\*\s*100/);
});

test("the pinned Three.js global build stays functional without its load-time deprecation warning", () => {
  assert.match(three, /const e="160"/);
  assert.doesNotMatch(three, /deprecated with r150|Please use ES Modules or alternatives/);
  assert.match(readme, /Three\.js 暂时固定为已经完整回归的 0\.160\.0 全局构建[\s\S]*本次不做高风险迁移/);
});

test("student documentation describes the expanded blocks and corrected units", () => {
  assert.match(readme, /5 米 × 3 米[\s\S]*40 × 24[\s\S]*12\.5 厘米/);
  assert.match(readme, /与广阳岛 Python 项目采用同一[\s\S]*自主控制能力层级/);
  assert.match(readme, /厘米前进\/后退[\s\S]*顺序与条件选择[\s\S]*持续循环[\s\S]*导航传感[\s\S]*道路控制[\s\S]*摄像头感知[\s\S]*变量[\s\S]*函数/);
  assert.match(readme, /历史作品中的按秒移动积木[\s\S]*不再显示/);
  assert.match(guide, /小车移动：[\s\S]*物品操作：[\s\S]*顺序与选择：[\s\S]*循环：[\s\S]*基础传感：[\s\S]*导航传感：[\s\S]*道路控制：[\s\S]*摄像头感知：[\s\S]*数据与列表：[\s\S]*等待与输出：[\s\S]*数学与逻辑：[\s\S]*文本：[\s\S]*变量：[\s\S]*函数：/);
  assert.match(guide, /单个受控循环最多执行 100 次[\s\S]*持续巡逻[\s\S]*点击停止/);
  assert.match(guide, /任务锚点只提供道路编号和沿路进度[\s\S]*不提供 X、Z[\s\S]*1000 次导航传感查询/);
  assert.match(guide, /沿当前道路行驶[\s\S]*10～500 厘米[\s\S]*不会计算从起点到终点的完整路线[\s\S]*300 次道路控制/);
  assert.match(guide, /车头左右 60°[\s\S]*500 厘米以内[\s\S]*不进行摄像头模型训练[\s\S]*真实小车（不计分）[\s\S]*仅供人工查看的摄像头实时画面[\s\S]*不会提供给积木程序、保存或上传[\s\S]*不提供定位、传感或任务状态回传/);
  assert.doesNotMatch(`${readme}\n${guide}`, /低年级|小学\s*1\s*[–—-]\s*3\s*年级|简化版/);
  assert.match(readme, /道路边缘(?:至少)?\s*2\.5 厘米/);
  assert.match(guide, /道路边缘(?:至少)?\s*2\.5 厘米/);
  assert.doesNotMatch(`${readme}\n${guide}`, /离道路边缘至少 20 厘米/);
});
