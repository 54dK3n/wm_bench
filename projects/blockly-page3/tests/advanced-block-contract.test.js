"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const app = read("app.js");
const html = read("index.html");
const server = read("server.js");
const adminHtml = read("admin.html");
const adminJs = read("admin.js");
const navigationCore = read("blockly-navigation-core.js");
const readme = read("README.md");
const guide = read("指导书.md");
const toolbox = html.match(/<xml id="toolbox"[\s\S]*?<\/xml>/)?.[0] || "";

const ADVANCED_BLOCKS = Object.freeze([
  "robot_mission",
  "robot_task_state",
  "robot_release_preview",
  "robot_odometry",
  "robot_odometry_value",
  "robot_road_state",
  "robot_road_boolean",
  "robot_road_number",
  "robot_road_text",
  "robot_map_graph",
  "robot_follow_road",
  "robot_take_exit",
  "robot_last_road_result",
  "robot_last_road_result_value",
  "robot_vision_sees",
  "robot_vision_count",
  "robot_vision_direction",
  "robot_vision_distance",
  "robot_vision_near",
  "robot_vision_centered",
  "robot_vision_observe",
  "robot_vision_detect",
  "robot_vision_approach",
  "robot_data_get",
  "robot_list_item",
  "robot_data_length",
  "robot_json_text"
]);

const NAVIGATION_METHODS = Object.freeze([
  "odometry", "road_state", "map_graph", "mission", "task_state", "release_preview"
]);
const ROAD_METHODS = Object.freeze(["follow_road", "take_exit"]);
const VISION_METHODS = Object.freeze([
  "sees", "count", "detect", "near", "centered", "direction", "distance_to", "approach", "observe"
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function frozenStringArray(source, name) {
  const match = source.match(new RegExp(`const ${escapeRegExp(name)} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `${name} 常量不存在`);
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map(item => item[1]);
}

function scriptPosition(source, fileName) {
  const position = source.indexOf(`src="./${fileName}`);
  assert.notEqual(position, -1, `${fileName} 未加载`);
  return position;
}

test("every advanced toolbox block has a definition path and a JavaScript generator", () => {
  ADVANCED_BLOCKS.forEach(type => {
    assert.match(toolbox, new RegExp(`<block type="${escapeRegExp(type)}"`), `${type} 未放入工具箱`);
  });

  const navigationDefinitions = {
    robot_mission: "mission",
    robot_task_state: "task_state",
    robot_release_preview: "release_preview",
    robot_odometry: "odometry",
    robot_road_state: "road_state",
    robot_map_graph: "map_graph"
  };
  Object.entries(navigationDefinitions).forEach(([type, method]) => {
    assert.match(app, new RegExp(`\\["${type}",[^\\n]+"${method}"`), `${type} 缺少导航定义`);
  });
  assert.match(app, /navigationSensorBlocks\.forEach\([\s\S]*?Blockly\.Blocks\[type\][\s\S]*?Blockly\.JavaScript\[type\][\s\S]*?robot\.\$\{method\}\(\)/);

  const fieldBlocks = {
    robot_odometry_value: "odometry",
    robot_road_boolean: "road_state",
    robot_road_number: "road_state",
    robot_road_text: "road_state"
  };
  Object.entries(fieldBlocks).forEach(([type, method]) => {
    assert.match(app, new RegExp(`defineSensorFieldBlock\\("${type}",[\\s\\S]*?"${method}"`), `${type} 缺少字段积木定义`);
  });
  assert.match(app, /Blockly\.JavaScript\[type\] = block =>[\s\S]*?robot\.sensorField\("\$\{method\}", \$\{JSON\.stringify\(field\)\}\)/);

  const visionBlocks = {
    robot_vision_sees: "sees",
    robot_vision_count: "count",
    robot_vision_direction: "direction",
    robot_vision_distance: "distance_to",
    robot_vision_near: "near",
    robot_vision_centered: "centered",
    robot_vision_observe: "observe",
    robot_vision_detect: "detect"
  };
  Object.entries(visionBlocks).forEach(([type, method]) => {
    assert.match(app, new RegExp(`defineVisionQueryBlock\\("${type}",[\\s\\S]*?"${method}"`), `${type} 缺少视觉定义`);
  });
  assert.match(app, /Blockly\.JavaScript\[type\] = block =>[\s\S]*?robot\.\$\{method\}\(\$\{target\}, \$\{confidence\}\)/);

  for (const type of [
    "robot_follow_road", "robot_take_exit", "robot_last_road_result", "robot_last_road_result_value",
    "robot_vision_approach", "robot_data_get", "robot_list_item", "robot_data_length", "robot_json_text"
  ]) {
    assert.match(app, new RegExp(`Blockly\\.Blocks\\.${type}\\s*=`), `${type} 缺少定义`);
    assert.match(app, new RegExp(`Blockly\\.JavaScript\\.${type}\\s*=`), `${type} 缺少生成器`);
  }
});

test("advanced generators call only the documented robot API with the expected arguments", () => {
  assert.match(app, /return `await robot\.follow_road\(\$\{maxCm\}, \$\{speed\}, \$\{obey\}\);\\n`/);
  assert.match(app, /return `await robot\.take_exit\(\$\{roadId\}, \$\{speed\}, \$\{obey\}\);\\n`/);
  assert.match(app, /robot\.lastRoadResult\(\)/);
  assert.match(app, /robot\.dataGet\(robot\.lastRoadResult\(\), \$\{JSON\.stringify\(block\.getFieldValue\("FIELD"\)\)\}\)/);
  assert.match(app, /return `await robot\.approach\(\$\{target\}, \$\{distance\}, \$\{steps\}\);\\n`/);
  assert.match(app, /robot\.dataGet\(\$\{object\}, \$\{key\}\)/);
  assert.match(app, /robot\.listItem\(\$\{list\}, \$\{index\}\)/);
  assert.match(app, /robot\.dataLength\(\$\{value\}\)/);
  assert.match(app, /robot\.jsonText\(\$\{value\}\)/);

  assert.match(app, /const visionTargets = \[\["目标物", "目标物"\], \["混淆物", "混淆物"\], \["障碍物", "障碍物"\], \["存放点", "存放点"\]\]/);
  assert.match(app, /const visionTargetsWithAll = \[\["全部", "全部"\], \.\.\.visionTargets\]/);
  assert.match(app, /const confidence = [^\n]+\|\| "0\.6"/);
  assert.match(app, /const distance = [^\n]+\|\| "20"/);
  assert.match(app, /const steps = [^\n]+\|\| "60"/);
});

test("navigation assets load before app.js and are served by the standalone server", () => {
  const scoring = scriptPosition(html, "guangyang-scoring.js");
  const maps = scriptPosition(html, "guangyang-map-config.js");
  const teamScores = scriptPosition(html, "admin-team-scores.js");
  const navigation = scriptPosition(html, "blockly-navigation-core.js");
  const application = scriptPosition(html, "app.js");
  assert.ok(scoring < maps && maps < teamScores && teamScores < navigation && navigation < application);
  assert.ok(html.indexOf("blockly_compressed.js") < application);
  assert.ok(html.indexOf("javascript_compressed.js") < application);
  for (const file of [
    "guangyang-scoring.js", "guangyang-map-config.js", "admin-team-scores.js",
    "blockly-navigation-core.js", "app.js", "admin.css"
  ]) {
    assert.match(server, new RegExp(`\\["/${escapeRegExp(file)}", "${escapeRegExp(file)}"\\]`), `${file} 未由服务端提供`);
  }
});

test("browser runtime and server share one exact fixed executionTrace whitelist", () => {
  assert.deepEqual(frozenStringArray(app, "NAVIGATION_SENSOR_METHODS"), NAVIGATION_METHODS);
  assert.deepEqual(frozenStringArray(server, "NAVIGATION_SENSOR_METHODS"), NAVIGATION_METHODS);
  assert.deepEqual(frozenStringArray(app, "ROAD_CONTROL_METHODS"), ROAD_METHODS);
  assert.deepEqual(frozenStringArray(server, "ROAD_CONTROL_METHODS"), ROAD_METHODS);
  assert.deepEqual(frozenStringArray(app, "VISION_METHODS"), VISION_METHODS);
  assert.deepEqual(frozenStringArray(server, "VISION_METHODS"), VISION_METHODS);

  assert.match(app, /const TRACKED_ROBOT_METHODS = new Set\(\[\.\.\.NAVIGATION_SENSOR_METHODS, \.\.\.ROAD_CONTROL_METHODS, \.\.\.VISION_METHODS\]\)/);
  assert.match(app, /executedApiMethods: \[\][\s\S]*?executedApiMethodSet: new Set\(\)/);
  assert.match(app, /function recordExecutedRobotMethod\(context, method\)[\s\S]*?TRACKED_ROBOT_METHODS\.has\(method\)[\s\S]*?executedApiMethodSet\.has\(method\)[\s\S]*?executedApiMethods\.push\(method\)/);
  assert.match(app, /navigationSensorTick\(context, method\)[\s\S]*?recordExecutedRobotMethod\(context, method\)/);
  assert.match(app, /queryBlocklyVision\(context, method,[\s\S]*?recordExecutedRobotMethod\(context, method\)/);
  assert.match(app, /approachBlocklyVisionTarget\(context,[\s\S]*?recordExecutedRobotMethod\(context, "approach"\)/);
  assert.match(app, /beginRoadControl\(context, method\)[\s\S]*?recordExecutedRobotMethod\(context, method\)/);
  assert.match(app, /executionTrace: Array\.isArray\(context\?\.executedApiMethods\) \? \[\.\.\.context\.executedApiMethods\] : \[\]/);

  assert.match(server, /const MAX_EXECUTION_TRACE_ENTRIES = 64/);
  assert.match(server, /if \(!Array\.isArray\(value\) \|\| value\.length > MAX_EXECUTION_TRACE_ENTRIES\)/);
  assert.match(server, /!EXECUTION_METHOD_SET\.has\(method\)/);
  assert.match(server, /methods\.add\(method\)/);
  assert.match(server, /return EXECUTION_METHODS\.filter\(method => methods\.has\(method\)\)/);
  assert.doesNotMatch(server, /(?:programCode|workspaceXml)\.(?:includes|match|matchAll|search)\(/);
});

test("runtime capability groups survive summary, detail, admin display and record export", () => {
  assert.match(server, /function recordSummary\(record\)[\s\S]*?executionTrace: runtimeCapability\.executionTrace[\s\S]*?capabilityUsage: runtimeCapability\.capabilityUsage/);
  assert.match(server, /function adminRecordSummary\(record, usersById = null\)[\s\S]*?\.\.\.recordSummary\(record\)/);
  assert.match(server, /\/api\/admin\/records[\s\S]*?\.map\(record => adminRecordSummary\(record, usersById\)\)/);
  assert.match(server, /\/api\/admin\/export\/records[\s\S]*?\.\.\.adminRecordSummary\(record, usersById\)[\s\S]*?programCode: record\.programCode/);

  assert.match(adminHtml, /<th>能力使用<\/th>/);
  assert.match(adminHtml, /id="adminRecordCapabilities"/);
  assert.match(adminJs, /navigationSensorMethods[^\n]+导航传感/);
  assert.match(adminJs, /roadControlMethods[^\n]+道路控制/);
  assert.match(adminJs, /visionMethods[^\n]+摄像头感知/);
  assert.match(adminJs, /badge\.title = `运行时上报：\$\{group\.methods\.join\("、"\)\}`/);
  assert.match(adminJs, /renderRuntimeCapabilities\(capabilityCell, record\)/);
  assert.match(adminJs, /renderRuntimeCapabilities\(capabilities, record, \{ detail: true \}\)/);
});

test("student-facing navigation and vision data stay coordinate-free", () => {
  assert.match(app, /return \{ role: item\.role, roadId: anchor\.roadId, progressCm: anchor\.progressCm \}/);
  assert.match(app, /objects: objectAnchors/);
  assert.match(app, /function readBlocklyMapGraph\(context\)[\s\S]*?getPrimaryNavigationNetwork\(\)\.mapGraph\(\)/);
  assert.match(app, /function visionObservationSummary\(item\)[\s\S]*?distanceCm: item\.distanceCm[\s\S]*?confidence: item\.confidence/);
  assert.doesNotMatch(app.match(/function visionObservationSummary\(item\)[\s\S]*?\n\}/)?.[0] || "", /\b(?:x|z|position|point|points)\s*:/);
  assert.match(app, /const blockedDataKeys = new Set\(\["__proto__", "prototype", "constructor", "x", "z", "points", "point"\]\)/);
  assert.match(app, /导航数据不开放坐标或内部几何字段/);

  assert.match(navigationCore, /const graph = deepFreeze\(\{[\s\S]*?nodes: nodes\.map\(node => \(\{ nodeId: node\.nodeId, roadIds: \[\.\.\.node\.roadIds\] \}\)\)[\s\S]*?fromNodeId[\s\S]*?toNodeId[\s\S]*?lengthCm/);
  assert.match(navigationCore, /function anchorAt\(x, z, id = null\)[\s\S]*?roadId: projection\.roadId[\s\S]*?progressCm: projection\.progressCm/);
  const anchorBody = navigationCore.match(/function anchorAt\(x, z, id = null\)[\s\S]*?return deepFreeze\(anchor\);\n    \}/)?.[0] || "";
  assert.ok(anchorBody, "找不到公开锚点序列化函数");
  assert.doesNotMatch(anchorBody, /\b(?:x|z|point|points|position)\s*:/);
});

test("camera query semantics match the Python public contract", () => {
  assert.match(app, /const isStable = item => Boolean\(item\) && item\.stable !== false/);
  assert.match(app, /if \(method === "sees"\) \{[\s\S]*?matches\.some\(item => isStable\(item\)[\s\S]*?&& item\.centered[\s\S]*?target !== "障碍物" \|\| item\.distanceCm <= 30/);
  assert.match(app, /if \(method === "count"\) return matches\.filter\(isStable\)\.length/);
  assert.match(app, /if \(method === "near"\) return matches\.some\(item => isStable\(item\) && item\.near\)/);
  assert.match(app, /if \(method === "centered"\) return matches\.some\(item => isStable\(item\) && item\.centered\)/);
  assert.match(app, /if \(method === "observe"\) return matches\.filter\(isStable\)\.map\(visionObservationSummary\)/);
  assert.match(app, /near: item\.near && item\.centered/);
  assert.match(app, /"接近夹取距离": item\.near && item\.centered/);
});

test("async Blockly procedures cannot bypass loop safety with unbounded recursion", () => {
  assert.match(app, /const MAX_PROGRAM_PROCEDURE_CALLS = 1000/);
  assert.match(app, /const MAX_PROGRAM_PROCEDURE_DEPTH = 50/);
  assert.match(app, /procedureCallCount: 0[\s\S]*?procedureCallDepth: 0/);
  assert.match(app, /function defineAsyncProcedureGenerators\(\)[\s\S]*?robot\.procedureEnter\(\$\{JSON\.stringify\(name\)\}\)[\s\S]*?try \{[\s\S]*?robot\.procedureExit\(\)/);
  assert.match(app, /api\.procedureEnter = async name =>[\s\S]*?procedureCallCount > MAX_PROGRAM_PROCEDURE_CALLS[\s\S]*?procedureCallDepth > MAX_PROGRAM_PROCEDURE_DEPTH/);
  assert.match(app, /abortRunContext\(context, "procedure-limit"\)/);
  assert.match(app, /api\.procedureExit = \(\) =>[\s\S]*?Math\.max\(0, context\.procedureCallDepth - 1\)/);
  assert.match(readme, /函数累计最多调用 1000 次、递归最多 50 层/);
  assert.match(guide, /函数累计最多调用 1000 次，递归调用最多 50 层/);
});
