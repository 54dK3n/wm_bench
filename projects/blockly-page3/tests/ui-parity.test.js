const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const adminJs = fs.readFileSync(path.join(root, "admin.js"), "utf8");
const adminTeamScores = fs.readFileSync(path.join(root, "admin-team-scores.js"), "utf8");
const loginHtml = fs.readFileSync(path.join(root, "login.html"), "utf8");
const authJs = fs.readFileSync(path.join(root, "auth.js"), "utf8");
const mapConfig = fs.readFileSync(path.join(root, "guangyang-map-config.js"), "utf8");

test("authenticated account controls respect the hidden attribute", () => {
  assert.doesNotMatch(`${html}\n${adminHtml}\n${loginHtml}\n${authJs}`, /小车乐园|小车闯关/);
  assert.match(loginHtml, /id="authHeading"/);
  assert.match(authJs, /heading\.hidden = !isLogin/);
  assert.doesNotMatch(authJs, /创建闯关账户|创建或加入队伍后，保存自己的闯关成绩/);
  assert.match(loginHtml, /<title>登录 · 广阳岛 Blockly<\/title>/);
  assert.match(loginHtml, /<strong>广阳岛 Blockly<\/strong>/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(app, /loginButton\.hidden = signedIn/);
  assert.match(app, /adminButton\.hidden = primaryUser\?\.role !== "admin"/);
});

test("student and administrator workspaces can return to the unified platform", () => {
  assert.match(html, /styles\.css\?v=\d{8}-\d{3}/);
  assert.match(html, /<a id="platformReturnButton" class="platform-return-button" href="\/portal\.html" aria-label="返回统一平台"/);
  assert.doesNotMatch(html, /<a id="platformReturnButton"[^>]*hidden/);
  assert.match(css, /\.platform-return-button\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?text-decoration:\s*none;/);
  assert.match(css, /\.platform-return-button:focus-visible/);
});

test("Blockly exposes real-car control and human-only camera preview without perception or scoring", () => {
  assert.match(html, /id="targetSelect"[\s\S]*value="sim"[\s\S]*value="real">真实小车（不计分）/);
  assert.match(html, /id="robotConnection"[\s\S]*id="robotBaseUrl"[\s\S]*id="applyRobotIpButton"/);
  assert.match(html, /id="cameraStream"[\s\S]*id="cameraStatus"[\s\S]*仅实时预览 · 不识别[\s\S]*id="retryCameraButton"/);
  assert.match(html, /画面只供人工查看，不会交给积木程序、保存、上传或参与评分[\s\S]*实车仍不提供定位、传感或任务状态/);
  assert.match(css, /\.app-shell\.is-real-target \.primary-score-hud[\s\S]*display:\s*none !important/);
  assert.match(css, /\.app-shell\.is-real-target \.topbar[\s\S]*flex-wrap:\s*wrap/);
  assert.match(css, /data-camera-state="streaming"[\s\S]*#cameraStream[\s\S]*opacity:\s*1/);
  assert.match(app, /function makeRealRobotApi\(context\)/);
  assert.match(app, /new URL\(`\$\{baseUrl\}\/api\/control`\)/);
  for (const action of ["up", "down", "left", "right", "grab", "release", "stop"]) {
    assert.match(app, new RegExp(`["']${action}["']`), `missing real-car action ${action}`);
  }
  assert.match(app, /\/api\/camera\/\$\{command\}/);
  assert.match(app, /\/api\/camera\/stream/);
  assert.match(app, /postRealCameraCommand\(baseUrl, "open"\)/);
  assert.match(app, /postRealCameraCommand\(baseUrl, "close"/);
  assert.doesNotMatch(app, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(app, /realRobotUnsupportedMethodsInProgram\(runtimeCode\)[\s\S]*实车仅支持基础动作/);
  assert.match(app, /context\.target === "sim"[\s\S]*archivePrimaryRun/);
  assert.match(app, /async function archivePrimaryRun[\s\S]*context\?\.target !== "sim"[\s\S]*return null/);
  assert.match(app, /targetSelect\.value = "sim";[\s\S]*setRunTarget\("sim"\)/);
  assert.match(app, /visibilitychange[\s\S]*stopRealCameraPreview[\s\S]*sendRealRobotStop/);
  assert.match(app, /pagehide[\s\S]*stopRealCameraPreview[\s\S]*abortRunContext\(context, "page-hidden"\)[\s\S]*sendRealRobotStop/);
  assert.match(app, /let realStopPromise = null;[\s\S]*if \(realStopPromise\) return realStopPromise/);
  assert.match(app, /parsed\.pathname !== "\/" \|\| parsed\.search \|\| parsed\.hash/);
  assert.match(server, /connect-src 'self' http: https:/);
  assert.match(server, /img-src 'self' data: http: https:/);
  assert.match(server, /Permissions-Policy": "camera=\(\)/);
});

test("score HUD starts idle and exposes collapsible Python-style details", () => {
  assert.match(html, /id="primaryScoreValue">--</);
  assert.match(html, /class="score-reference-note">仅供参考<br>最终成绩以后台计算为准<\/small>/);
  assert.match(html, /id="primaryScoreToggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="primaryScoreBody" hidden/);
  assert.match(app, /initPrimaryScoreToggle\(\)/);
  assert.match(app, /score\.total === null \? "--"/);
});

test("three challenges use their independently published Guangyang world positions", () => {
  assert.match(mapConfig, /checkpoints: \[\[-2\.4865, -2\.4556\], \[7\.1815, -3\.2587\], \[6\.471, 0\.4479\], \[4\.4324, 6\.8726\]\]/);
  assert.match(mapConfig, /\[-11\.5985, -0\.7568\], \[13\.7297, 0\.7568\]/);
  assert.match(mapConfig, /targets: \[\[-9\.8687, -6\.7181\]\]/);
  assert.match(mapConfig, /targets: \[\[-9\.8387, -6\.7181\], \[9\.3127, -3\.2587\]\]/);
  assert.match(mapConfig, /\[10\.0849, 1\.251\]/);
  assert.match(mapConfig, /storage: \[-10\.7336, -8\.0772\]/);
  assert.match(app, /const storage = \[\.\.\.task\.storage\]/);
  assert.match(app, /showGuidePath: false/);
  assert.match(server, /GYI-PRIMARY-01"[^\n]+checkpoints: 4/);
  assert.match(server, /GYI-PRIMARY-02"[^\n]+checkpoints: 6/);
  assert.match(server, /GYI-PRIMARY-03"[^\n]+checkpoints: 8/);
});

test("Guangyang checkpoints share the Python appearance and show their ordered rule boundary", () => {
  assert.match(app, /const checkpointColors = \["#22d3ee", "#a78bfa", "#f59e0b", "#ec4899"\]/);
  assert.match(app, /createMazeCheckpoint\(point, index, color\)/);
  assert.match(app, /new THREE\.RingGeometry\(Math\.max\(0\.08, visualRadius - 0\.045\), visualRadius, 64\)/);
  assert.match(app, /createTextLabel\(`导航 \$\{index \+ 1\}`/);
});

test("map keeps the decoded source image while adding terrain and full relief", () => {
  assert.match(app, /bakedVehiclePatch/);
  assert.match(app, /createPrimaryGuangyangTerrainMesh\(canvas, texture\)/);
  assert.match(app, /\[428, 648, 52, 38, 17, "gold"\]/);
  assert.match(app, /primaryGuangyangReliefRoot\.visible = mode !== "top"/);
});

test("decorative tree crowns stay inside planted land and away from roads", () => {
  assert.match(app, /function primaryGuangyangTreeFootprintIsLand\(context, canvas, pixelX, pixelY, scale\)/);
  assert.match(app, /const offsets = \[/);
  assert.match(app, /greenLand \|\| goldenPlanting/);
  assert.match(app, /maximumAttempts = count \* 14/);
  assert.match(app, /buildPrimaryGuangyangRelief\(canvas\)/);
  assert.doesNotMatch(app, /\n  buildPrimaryGuangyangRelief\(\);\n  buildPrimaryGuangyangTaskObjects/);
});

test("student runs are saved first and only explicitly submitted records reach admin", () => {
  assert.match(app, /primaryUser\.username/);
  assert.match(app, /submitPrimaryRecord\(recordId, button\)/);
  assert.match(app, /提交最高分/);
  assert.match(server, /recordState: "saved"/);
  assert.match(server, /\/api\/records\/\$\{recordId\}\/submit|record-submit-receipt\/v1/);
  assert.match(server, /record\.recordState === "submitted"/);
  assert.match(html, /id="primaryTaskHighScores"[\s\S]*任务1[\s\S]*任务2[\s\S]*任务3/);
  assert.match(app, /buildSubmittedTaskScores\(/);
});

test("admin uses team wording and can inspect and export submitted programs", () => {
  assert.doesNotMatch(adminHtml, /班级/);
  assert.match(adminHtml, /id="adminUserGroupFilter"[\s\S]*小学组[\s\S]*初中组[\s\S]*高中组/);
  assert.match(adminHtml, /id="adminRecordGroupFilter"[\s\S]*小学组[\s\S]*初中组[\s\S]*高中组/);
  assert.match(adminHtml, /<th>小组<\/th>/);
  assert.doesNotMatch(`${adminHtml}\n${adminJs}`, /小学组（1-3年级）|小学组（4-6年级）|primary_low|primary_high/);
  assert.match(adminHtml, /比赛管理/);
  assert.match(adminHtml, /id="exportAdminUsers"/);
  assert.match(adminHtml, /id="exportAdminRecords"/);
  assert.match(adminHtml, /id="adminRecordProgramCode"/);
  assert.match(adminHtml, /id="adminRecordWorkspace"/);
  assert.match(adminJs, /查看程序/);
  assert.match(adminJs, /api\/admin\/export\/\$\{kind\}/);
  assert.match(adminHtml, /data-admin-tab="records"/);
  assert.match(adminHtml, /data-admin-tab="users"/);
  assert.match(adminHtml, /data-admin-tab="maps"/);
  assert.match(adminHtml, /id="adminUsersPageInfo"/);
  assert.match(adminHtml, /id="adminRecordsPageInfo"/);
  assert.match(adminHtml, /id="adminMapCanvas"/);
  assert.match(adminJs, /api\/admin\/maps/);
  assert.match(loginHtml, /id="registerGroup"[\s\S]*value="primary"[\s\S]*value="junior"[\s\S]*value="high"/);
  assert.match(authJs, /group: registerGroup\.value/);
});

test("unified platform mode keeps Blockly records but disables its ignored local map editor", () => {
  assert.match(adminJs, /const platformMode = new URLSearchParams\(window\.location\.search\)/);
  assert.match(adminJs, /platformMode \? \[loadUsers\(\), loadRecords\(\)\] : \[loadUsers\(\), loadRecords\(\), loadMaps\(\)\]/);
  assert.match(adminJs, /mapTab\.hidden = true/);
  assert.match(adminJs, /mapPanel\.hidden = true/);
  assert.match(adminJs, /比赛地图请在统一平台编辑/);
  assert.match(adminJs, /returnTo: "\/blockly\/admin\.html\?platform=1"/);
  assert.match(app, /returnTo: "\/blockly\/"/);
  assert.match(app, /window\.location\.replace\(`\/login\.html\?\$\{parameters\.toString\(\)\}`\)/);
});

test("runtime-reported API capability markers are derived without scanning Blockly code", () => {
  assert.match(server, /CAPABILITY_USAGE_SCHEMA_VERSION = "chenlong\.blockly-runtime-capability-usage\/v1"/);
  assert.match(server, /NAVIGATION_SENSOR_METHODS = Object\.freeze\(\[[\s\S]*"odometry"[\s\S]*"release_preview"/);
  assert.match(server, /ROAD_CONTROL_METHODS = Object\.freeze\(\["follow_road", "take_exit"\]\)/);
  assert.match(server, /VISION_METHODS = Object\.freeze\(\[[\s\S]*"sees"[\s\S]*"observe"/);
  assert.match(server, /function normalizeExecutionTrace\(value\)/);
  assert.match(server, /executionTrace: runtimeCapability\.executionTrace/);
  assert.match(server, /capabilityUsage: runtimeCapability\.capabilityUsage/);
  assert.doesNotMatch(server, /(?:programCode|workspaceXml)\.(?:includes|match|matchAll|search)\(/);
  assert.match(adminHtml, /<th>能力使用<\/th>/);
  assert.match(adminHtml, /id="adminRecordCapabilities"/);
  assert.match(adminJs, /运行时上报的能力使用/);
  assert.match(adminJs, /导航传感/);
  assert.match(adminJs, /道路控制/);
  assert.match(adminJs, /摄像头感知/);
});

test("admin records can filter tasks and select each team's best result per task", () => {
  assert.match(adminHtml, /id="adminRecordTaskFilter"/);
  assert.match(adminHtml, /value="GYI-PRIMARY-01"/);
  assert.match(adminHtml, /value="GYI-PRIMARY-02"/);
  assert.match(adminHtml, /value="GYI-PRIMARY-03"/);
  assert.match(adminHtml, /id="adminRecordScope"/);
  assert.match(adminHtml, /value="team-task-best">每队每任务最高分/);
  assert.match(adminJs, /bestByTeamAndTask/);
  assert.match(adminJs, /const key = `\$\{teamKey\}\\u0000\$\{record\.taskId\}`/);
  assert.match(adminJs, /record\.score === current\.score.*record\.submittedAt/s);
});

test("admin records include a fifteen-team three-challenge high-score summary", () => {
  assert.match(adminHtml, /id="adminTeamChallengeBestTitle">各队三项最高分/);
  assert.match(adminHtml, /小组[\s\S]*任务1最高分[\s\S]*任务2最高分[\s\S]*任务3最高分[\s\S]*三项总分/);
  assert.match(adminHtml, /id="exportAdminTeamScores"/);
  assert.match(adminJs, /function exportTeamScores\(button\)[\s\S]*三项总分/);
  assert.match(adminHtml, /id="adminTeamChallengeBestPrevious"/);
  assert.match(adminHtml, /id="adminTeamChallengeBestNext"/);
  assert.match(adminHtml, /admin-team-scores\.js\?v=/);
  assert.match(adminTeamScores, /const DEFAULT_PAGE_SIZE = 15/);
  assert.match(adminTeamScores, /current === null \|\| score > current/);
  assert.match(adminJs, /paginateTeamScores\(rows, state\.teamScorePage, 15\)/);
  assert.ok(adminHtml.indexOf('id="adminTeamChallengeBestTitle"') > adminHtml.indexOf('id="adminRecordsPageInfo"'));
});
