const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const vision = fs.readFileSync(path.join(root, "vision.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "python-worker.js"), "utf8");
const loginHtml = fs.readFileSync(path.join(root, "login.html"), "utf8");
const authClient = fs.readFileSync(path.join(root, "auth.js"), "utf8");
const authGuard = fs.readFileSync(path.join(root, "auth-guard.js"), "utf8");
const recordsHtml = fs.readFileSync(path.join(root, "records.html"), "utf8");
const recordsClient = fs.readFileSync(path.join(root, "records.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const adminClient = fs.readFileSync(path.join(root, "admin.js"), "utf8");
const adminTeamScores = fs.readFileSync(path.join(root, "admin-team-scores.js"), "utf8");
const accountCss = fs.readFileSync(path.join(root, "account.css"), "utf8");
const core = require("../competition-core.js");
const serverModule = require("../server.js");

function functionSource(name, source = app) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const remaining = source.slice(start + 1);
  const nextDeclaration = /\n(?:async\s+)?function\s+/.exec(remaining);
  const next = nextDeclaration ? start + 1 + nextDeclaration.index : -1;
  return source.slice(start, next < 0 ? source.length : next);
}

function cssRule(selector, source = css) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] || "";
}

function cssPixelValues(selector, property) {
  const rule = cssRule(selector);
  assert.ok(rule, `missing CSS rule ${selector}`);
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = new RegExp(`(?:^|;)\\s*${escapedProperty}\\s*:\\s*([^;]+)`).exec(rule)?.[1] || "";
  const pixels = [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
  assert.ok(pixels.length, `missing pixel value for ${selector} ${property}`);
  return pixels;
}

test("all local scripts referenced by index.html exist", () => {
  const sources = [...html.matchAll(/<script\s+src="([^"]+)"/g)]
    .map(match => match[1].split("?")[0])
    .filter(source => source.startsWith("./"));
  assert.ok(sources.includes("./competition-core.js"));
  sources.forEach(source => assert.equal(fs.existsSync(path.join(root, source)), true, source));
});

test("documented local server port matches the runtime default", () => {
  assert.equal(serverModule.DEFAULT_PORT, 6178);
  assert.match(fs.readFileSync(path.join(root, "README.md"), "utf8"), /127\.0\.0\.1:6178/);
});

test("all authenticated Python surfaces provide a direct return to the unified portal", () => {
  for (const [surface, source] of [
    ["simulator", html],
    ["records", recordsHtml],
    ["admin", adminHtml]
  ]) {
    assert.match(
      source,
      /<a\b[^>]*href="\/portal\.html"[^>]*>[\s\S]*?<span>返回统一平台<\/span>[\s\S]*?<\/a>/,
      `${surface} is missing the unified portal return link`
    );
  }
  assert.match(html, /class="platform-return-link"[^>]*href="\/portal\.html"/);
  assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*auto\)\)\s+minmax\(0,\s*1fr\)\s+auto/);
  assert.match(css, /@media \(max-width: 1680px\)[\s\S]*?\.platform-return-link span\s*\{\s*display:\s*inline;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.platform-return-link span\s*\{\s*display:\s*none;/);
});

test("DOM ids queried by app.js exist and remain unique", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, "index.html contains duplicate ids");
  const queriedIds = [...app.matchAll(/querySelector\("#([A-Za-z0-9_-]+)"\)/g)].map(match => match[1]);
  queriedIds.forEach(id => assert.ok(ids.includes(id), `missing #${id}`));
});

test("general simulator actions expose visible status feedback", () => {
  assert.match(html, /id="appStatusToast"[^>]*role="status"[^>]*aria-live="polite"/);
  const statusSource = functionSource("setStatus");
  assert.match(statusSource, /appStatusToast\.textContent\s*=\s*text/);
  assert.match(statusSource, /appStatusToast\.hidden\s*=\s*false/);
  assert.match(css, /\.app-status-toast\.is-visible/);
  assert.match(css, /\.app-status-toast\[hidden\]/);
});

test("the visible command guide exposes only the current competition essentials", () => {
  const commandBlock = /<div class="python-command-list"[\s\S]*?<section id="visionApiHelp"/.exec(html)?.[0] || "";
  const visibleMethods = [...commandBlock.matchAll(/robot\.([a-z0-9_]+)\s*\(/g)].map(match => match[1]);
  assert.deepEqual(visibleMethods, [
    "forward", "backward", "left_angle", "right_angle",
    "mission", "task_state", "release_preview", "odometry", "road_state", "map_graph", "follow_road", "take_exit",
    "observe", "approach", "grab", "release", "holding"
  ]);
  visibleMethods.forEach(method => {
    assert.match(worker, new RegExp(`async def ${method}\\(self(?:,|\\))`), `missing Robot.${method} implementation`);
  });
  assert.match(commandBlock, /role="list"[^>]*aria-label="常用 Python 小车指令"/);
  assert.equal((commandBlock.match(/role="listitem"/g) || []).length, 17);
  assert.doesNotMatch(commandBlock, /robot\.(?:left|right|left_90|right_90|wait|sees|count|detect|near|centered|direction|distance_to|route_to|go_to|pathfind)\s*\(/);
  assert.match(commandBlock, /aria-label="道路控制指令"[\s\S]*robot\.follow_road\(100,\s*40,\s*True\)[\s\S]*robot\.take_exit\(road_id,\s*40,\s*True\)/);

  const help = /<section id="visionApiHelp"[\s\S]*?<\/section>/.exec(html)?.[0] || "";
  assert.deepEqual([...new Set([...help.matchAll(/robot\.([a-z0-9_]+)\s*\(/g)].map(match => match[1]))],
    ["odometry", "mission", "task_state", "release_preview", "road_state", "map_graph", "follow_road", "forward", "take_exit", "observe", "approach", "holding"]);
  assert.doesNotMatch(help, /名字|红球|approach\([^\n<]*,\s*30\)/);
  assert.match(help, /目标物[\s\S]*障碍物[\s\S]*混淆物[\s\S]*存放点/);
  assert.match(help, /不会寻找路口、选择出口、自动绕障或规划路线/);
  Object.values(core.NAVIGATION_DEFINITION.methods).forEach(method => {
    method.fields.forEach(field => assert.match(help, new RegExp(`\\b${field}\\b`), `missing navigation field ${field}`));
  });
  Object.entries(core.NAVIGATION_CONTROL_DEFINITION.methods).forEach(([methodName, method]) => {
    assert.match(help, new RegExp(`robot\\.${methodName}\\s*\\(`), `missing navigation control ${methodName}`);
    method.args.forEach(field => {
      const publicField = field === "obeySpeedLimit" ? "obey_speed_limit" : field;
      assert.match(help, new RegExp(`\\b${publicField}\\b`), `missing ${methodName} argument ${field}`);
    });
    method.resultFields.forEach(field => assert.match(help, new RegExp(`\\b${field}\\b`),
      `missing ${methodName} result field ${field}`));
  });
  assert.match(help, /仅用于广阳岛/);
  assert.match(help, /robot\.mission\(\)[\s\S]*roadId[\s\S]*progressCm[\s\S]*不返回任何世界坐标/);
  assert.match(help, /robot\.task_state\(\)[\s\S]*nextCheckpointId[\s\S]*任务引擎是否真正计分/);
  assert.match(help, /robot\.release_preview\(\)[\s\S]*wouldCompleteDelivery[\s\S]*不返回预落点坐标/);
  assert.match(help, /roadId[\s\S]*离路时表示最近道路/);
  assert.match(help, /横向偏移为正表示偏右、负表示偏左/);
  assert.match(help, /frontClearanceCm[\s\S]*500 cm[\s\S]*None/);
  assert.match(help, /roadProgressCm[\s\S]*fromNodeId[\s\S]*toNodeId[\s\S]*atNode[\s\S]*nodeId/);
  assert.match(help, /exits[\s\S]*roadId[\s\S]*direction[\s\S]*turnDeg/);
  assert.match(help, /left、straight、right 或 back[\s\S]*左正右负/);
  assert.match(help, /全部合法出口[\s\S]*不代表系统推荐/);
  assert.match(help, /robot\.map_graph\(\)[\s\S]*schemaVersion[\s\S]*nodes[\s\S]*edges/);
  assert.match(help, /nodeId[\s\S]*roadIds[\s\S]*fromNodeId[\s\S]*toNodeId[\s\S]*lengthCm[\s\S]*oneWay/);
  assert.match(help, /不会返回地图坐标、任务物体、推荐出口或规划路线[\s\S]*不会让小车移动/);
  assert.match(help, /follow_road[\s\S]*短程居中行驶[\s\S]*路口、道路端点、前方障碍或道路边界[\s\S]*先停车/);
  assert.match(help, /speed[\s\S]*期望速度占车辆最高速度的百分比[\s\S]*obey_speed_limit=True[\s\S]*自动钳制实际速度/);
  assert.match(help, /take_exit[\s\S]*学生从[\s\S]*road_state\(\)\["exits"\][\s\S]*选定[\s\S]*相邻道路后立即停车/);
  assert.match(help, /max_distance[\s\S]*junction[\s\S]*road_end[\s\S]*front_clearance[\s\S]*最多 300 次/);
  assert.match(help, /每次调用[\s\S]*完整动作[\s\S]*减小[\s\S]*maxCm[\s\S]*分多次调用/);
  assert.match(help, /不会寻找路口、选择出口、自动绕障或规划路线/);
  assert.doesNotMatch(help, /robot\.(?:route_to|go_to|pathfind)\s*\(/);
  assert.match(html, /data-example="road-sensor"[^>]*data-scene="guangyang"/);
  assert.match(html, /data-example="topology-plan"[^>]*data-scene="guangyang"/);
  assert.doesNotMatch(html, /data-example="(?:ai-autonomy|ai-target-delivery)"/,
    "the workspace must not expose the retired AI autonomy mode through examples");
  assert.doesNotMatch(html, /id="guangyangAiAutonomyModeButton"|AI 自主挑战/,
    "the retired AI autonomy toggle must not appear in the workspace");
  assert.match(html, /id="visionApiHelpButton"[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="visionApiHelp"[^>]*>[\s\S]*传感与道路控制 API/);
  assert.match(html, /id="visionApiHelp"[^>]*hidden[^>]*aria-label="传感与道路控制 API 说明"/);
  assert.match(cssRule(".vision-api-help-button:focus-visible"), /outline\s*:/);

  const editor = /<textarea id="pythonEditor"[\s\S]*?<\/textarea>/.exec(html)?.[0] || "";
  assert.match(editor, /robot\.right_angle\(90\)/);
  assert.doesNotMatch(editor, /robot\.(?:right_90|left_90|left|right|wait)\s*\(/);
  assert.match(editor, /robot\.mission\(\)[\s\S]*robot\.task_state\(\)[\s\S]*robot\.release_preview\(\)[\s\S]*robot\.map_graph\(\)[\s\S]*robot\.follow_road\(100,\s*40,\s*True\)[\s\S]*robot\.take_exit\(road_id,\s*40,\s*True\)/);
  assert.doesNotMatch(editor, /robot\.(?:route_to|go_to|pathfind)\s*\(/);
  assert.match(functionSource("renderPythonHighlight"), /holding[\s\S]*odometry[\s\S]*road_state[\s\S]*map_graph[\s\S]*mission[\s\S]*task_state[\s\S]*release_preview[\s\S]*observe[\s\S]*approach/);
  const roadSensorExample = /"road-sensor":\s*`([\s\S]*?)`,/.exec(app)?.[1] || "";
  assert.match(roadSensorExample, /robot\.mission\(\)[\s\S]*robot\.map_graph\(\)[\s\S]*robot\.odometry\(\)[\s\S]*robot\.road_state\(\)[\s\S]*robot\.task_state\(\)/);
  assert.doesNotMatch(roadSensorExample, /\b(?:world|nextExit|recommendedRoute|pathfind|route_to|go_to)\b|\[["']?[xz]["']?\]/i);
  const topologyPlanExample = /"topology-plan":\s*`([\s\S]*?)`,\s*avoid:/.exec(app)?.[1] || "";
  assert.match(topologyPlanExample, /robot\.mission\(\)[\s\S]*robot\.task_state\(\)[\s\S]*robot\.map_graph\(\)/);
  assert.match(topologyPlanExample, /robot\.release_preview\(\)[\s\S]*wouldCompleteDelivery[\s\S]*robot\.release\(\)/);
  assert.match(topologyPlanExample, /def shortest_roads[\s\S]*distance\[goal_node\]/);
  assert.match(topologyPlanExample, /robot\.road_state\(\)[\s\S]*robot\.follow_road\(500,\s*30\)/);
  assert.match(topologyPlanExample, /robot\.take_exit\(road_id\)[\s\S]*robot\.odometry\(\)/);
  const aiAutonomyExample = /"ai-autonomy":\s*`([\s\S]*?)`,\s*"ai-target-delivery"/.exec(app)?.[1] || "";
  assert.match(aiAutonomyExample, /robot\.mission\(\)[\s\S]*robot\.map_graph\(\)[\s\S]*robot\.task_state\(\)[\s\S]*mission\["objects"\]/);
  assert.match(aiAutonomyExample, /robot\.observe\([\s\S]*robot\.road_state\(\)[\s\S]*robot\.follow_road\([\s\S]*robot\.take_exit\(/);
  assert.doesNotMatch(aiAutonomyExample, /mission\["objects"\]\[|\["(?:x|z|progressCm)"\]/,
    "the AI starter must not rely on disclosed object route anchors or world coordinates");
  const aiTargetDeliveryExample = /"ai-target-delivery":\s*`([\s\S]*?)`,\s*"topology-plan"/.exec(app)?.[1] || "";
  assert.match(aiTargetDeliveryExample, /robot\.mission\(\)[\s\S]*robot\.map_graph\(\)[\s\S]*mission\["objects"\]/);
  assert.match(aiTargetDeliveryExample, /robot\.observe\("目标物"[\s\S]*robot\.approach\("目标物"[\s\S]*robot\.grab\(\)/);
  assert.match(aiTargetDeliveryExample, /def dijkstra[\s\S]*robot\.take_exit[\s\S]*robot\.follow_road[\s\S]*robot\.release_preview\([\s\S]*wouldCompleteDelivery[\s\S]*robot\.release\(\)/);
  assert.doesNotMatch(aiTargetDeliveryExample, /mission\["objects"\]\[|(?:target|distractor|obstacle)[-_][A-Za-z0-9]+/,
    "the AI delivery example must not encode private object anchors or object ids");
  assert.doesNotMatch(topologyPlanExample, /(?:route_to|go_to|pathfind|recommendedRoute|\[["']?[xz]["']?\])/i,
    "the teaching planner must calculate a route from public topology instead of embedding world coordinates");

  const trainingApi = /<div class="object-training-api"[\s\S]*?<\/div>/.exec(html)?.[0] || "";
  assert.match(trainingApi, /robot\.observe\("存放点"\)/);
  assert.match(trainingApi, /robot\.approach\("目标物",\s*100\)/);
  assert.doesNotMatch(trainingApi, /robot\.approach\("类别"/);
});

test("navigation mission, task state, release preview and map graph are no-argument queries without camera capture", () => {
  assert.match(worker, /mission:\s*\(\)\s*=>\s*requestRobot\("mission",\s*\[\]\)/);
  assert.match(worker, /task_state:\s*\(\)\s*=>\s*requestRobot\("task_state",\s*\[\]\)/);
  assert.match(worker, /release_preview:\s*\(\)\s*=>\s*requestRobot\("release_preview",\s*\[\]\)/);
  assert.match(worker, /map_graph:\s*\(\)\s*=>\s*requestRobot\("map_graph",\s*\[\]\)/);
  assert.match(worker, /async def mission\(self\):\s*\n\s*return json\.loads\(await js_robot\.mission\(\)\)/);
  assert.match(worker, /async def task_state\(self\):\s*\n\s*return json\.loads\(await js_robot\.task_state\(\)\)/);
  assert.match(worker, /async def release_preview\(self\):\s*\n\s*return json\.loads\(await js_robot\.release_preview\(\)\)/);
  assert.match(worker, /async def map_graph\(self\):\s*\n\s*return json\.loads\(await js_robot\.map_graph\(\)\)/);

  const sensorSource = functionSource("readNavigationSensor");
  assert.match(sensorSource, /method === "road_state"\s*\|\|\s*method === "map_graph"\s*\|\|\s*method === "mission"\s*\|\|\s*method === "task_state"\s*\|\|\s*method === "release_preview"/);
  assert.match(sensorSource, /currentGuangyangSceneConfig\(\)/);
  assert.match(sensorSource, /competitionSession\.addNavigationQuery\(method\)/);
  assert.match(sensorSource, /world:\s*simulationWorldDefinition\(\{\s*includePackages:\s*true\s*\}\)/);
  assert.match(sensorSource, /vehicleRadius:\s*ROBOT_RADIUS/);

  const handlerSource = functionSource("handleRealtimeRobotRequest");
  assert.match(handlerSource, /\["odometry", "road_state", "map_graph", "mission", "task_state", "release_preview"\]\.includes\(method\)/);
  assert.match(handlerSource, /navigationQueryCount\s*\+=\s*1[\s\S]*MAX_NAVIGATION_QUERIES_PER_RUN/);
  const mapGraphBranch = handlerSource.slice(handlerSource.indexOf('method === "map_graph"'), handlerSource.indexOf('method === "holding"'));
  assert.doesNotMatch(mapGraphBranch, /startVirtualCameraVision|projectSimpleVisionQuery/);
});

test("local road controls use one bounded auditable action without camera or route selection", () => {
  assert.match(worker, /follow_road:\s*\(maxCm,\s*speed,\s*obeySpeedLimit\)\s*=>\s*requestRobot\("follow_road",\s*\[maxCm,\s*speed,\s*obeySpeedLimit\]\)/);
  assert.match(worker, /take_exit:\s*\(roadId,\s*speed,\s*obeySpeedLimit\)\s*=>\s*requestRobot\("take_exit",\s*\[roadId,\s*speed,\s*obeySpeedLimit\]\)/);
  assert.match(worker, /async def follow_road\(self,\s*max_cm=100,\s*speed=40,\s*obey_speed_limit=False\):/);
  assert.match(worker, /async def take_exit\(self,\s*road_id,\s*speed=30,\s*obey_speed_limit=False\):/);

  const starterSource = functionSource("startCompetitionRun");
  assert.match(starterSource, /navigationControlDefinition:\s*globalThis\.CompetitionCore\.NAVIGATION_CONTROL_DEFINITION/);

  const controlSource = functionSource("executeNavigationControl");
  assert.match(controlSource, /currentGuangyangSceneConfig\(\)/);
  assert.match(controlSource, /normalizeNavigationControlAction\(method,\s*args/);
  assert.match(controlSource, /formalCompetition\s*=\s*isCompetitionMission\(\)/);
  assert.match(controlSource, /formalCompetition\s*&&\s*!competitionSession/);
  assert.match(controlSource, /formalCompetition\s*&&\s*competitionSession\.status\s*!==\s*"running"/);
  assert.match(controlSource, /navigationControlCount\s*\+=\s*1[\s\S]*MAX_NAVIGATION_CONTROLS_PER_RUN/);
  assert.match(controlSource, /competitionSession\.runNavigationControl\(simulatorCore,\s*action\.method,\s*action\.args/);
  assert.match(controlSource, /onJudgement:\s*summary\s*=>\s*\{\s*judgement\s*=\s*summary/);
  assert.match(controlSource, /new core\.NavigationActionRunner\(simulatorCore/);
  assert.match(controlSource, /playNavigationControlFrames\(frames,\s*simulatorCore,\s*playbackContext\)/);
  assert.match(controlSource, /renderCompetitionViolations\(judgement\.violations\)[\s\S]*consumeCompetitionTaskResult\(judgement\)/);
  assert.doesNotMatch(controlSource, /totalSeconds\s*>\s*MAX_PROGRAM_ACTION_SECONDS/,
    "a completed authoritative action must not fail a client-only time check after mutation");
  assert.doesNotMatch(controlSource, /startVirtualCameraVision|projectSimpleVisionQuery|route_to|go_to|pathfind/);

  const tickSource = functionSource("competitionTick");
  assert.match(tickSource, /navigationVisualPlayback\.runToken\s*===\s*runToken/);
  const playbackSource = functionSource("playNavigationControlFrames");
  assert.match(playbackSource, /navigationPlaybackContextIsCurrent\(context\)/);
  assert.match(playbackSource, /navigationVisualPlayback\s*===\s*context/);
  assert.match(playbackSource, /skipCompetitionTick:\s*context\.formalCompetition/);
  assert.match(playbackSource, /refreshPythonWatchdog\(\)/);

  const handlerSource = functionSource("handleRealtimeRobotRequest");
  const controlStart = handlerSource.indexOf('method === "follow_road"');
  const controlEnd = handlerSource.indexOf('method === "holding"', controlStart);
  assert.ok(controlStart >= 0 && controlEnd > controlStart, "missing local road control request branch");
  const controlBranch = handlerSource.slice(controlStart, controlEnd);
  assert.match(controlBranch, /const validCount\s*=\s*args\.length === 2 \|\| args\.length === 3/);
  assert.match(controlBranch, /obeySpeedLimit:\s*args\.length === 3 \? args\[2\] : false/);
  assert.match(controlBranch, /executeNavigationControl\(method/);
  assert.doesNotMatch(controlBranch, /startVirtualCameraVision|readNavigationSensor|route_to|go_to|pathfind/);
});

test("WebGL startup and context loss fail visibly instead of leaving a silent page", () => {
  const initSceneSource = functionSource("initScene");
  const startupErrorSource = functionSource("showSimulationStartupError");
  assert.match(initSceneSource, /try\s*{[\s\S]*new THREE\.WebGLRenderer/);
  assert.match(initSceneSource, /webglcontextlost/);
  assert.match(initSceneSource, /webglcontextrestored/);
  assert.match(startupErrorSource, /3D 渲染环境启动失败/);
  assert.match(startupErrorSource, /window\.location\.reload\(\)/);
});

test("Python exposes real-car control and human-only camera preview without perception or scoring", () => {
  assert.match(html, /id="targetSelect"[\s\S]*value="sim"[\s\S]*value="real">真实小车（不计分）/);
  assert.match(html, /id="robotConnection"[\s\S]*id="robotBaseUrl"[\s\S]*id="applyRobotIpButton"/);
  assert.match(html, /id="cameraStream"[\s\S]*id="cameraStatus"[\s\S]*仅实时预览 · 不识别[\s\S]*id="retryCameraButton"/);
  assert.match(html, /画面只供人工查看，不会交给 Python、保存、上传或参与评分[\s\S]*实车仍不提供定位、传感或任务状态/);
  assert.match(css, /\.app-shell\.is-real-target \.competition-hud[\s\S]*display:\s*none !important/);
  assert.match(css, /\.app-shell\.is-real-target \.sim-only-command/);
  assert.match(css, /data-camera-state="streaming"[\s\S]*#cameraStream[\s\S]*opacity:\s*1/);
  assert.match(app, /function makeRobotApi\(\)\s*{\s*return realtimeRun\?\.target === "real" \? makeRealRobotApi\(realtimeRun\) : makeSimRobotApi\(\);/);
  assert.match(app, /new URL\(`\$\{baseUrl\}\/api\/control`\)/);
  for (const action of ["up", "down", "left", "right", "grab", "release", "stop"]) {
    assert.match(app, new RegExp(`["']${action}["']`), `missing real-car action ${action}`);
  }
  assert.match(app, /\/api\/camera\/\$\{command\}/);
  assert.match(app, /\/api\/camera\/stream/);
  assert.match(app, /postRealCameraCommand\(baseUrl, "open"\)/);
  assert.match(app, /postRealCameraCommand\(baseUrl, "close"/);
  assert.doesNotMatch(app, /navigator\.mediaDevices\.getUserMedia/);

  const handlerSource = functionSource("handleRealtimeRobotRequest");
  assert.ok(handlerSource.indexOf('realtimeRun.target === "real" && !isRealtimeAction(method)')
    < handlerSource.indexOf('["odometry", "road_state"'), "real-car allowlist must run before every sensor branch");
  assert.match(worker, /student_run_target == 'real'[\s\S]*real_allowed_methods[\s\S]*real_unsupported_methods/);
  assert.match(worker, /real_forbidden_names[\s\S]*'js_robot'[\s\S]*'globals'/);
  assert.match(worker, /node\.id\.startswith\('__'\)/);
  assert.match(worker, /real_builtins\['__import__'\] = real_import/);
  assert.match(worker, /scope = \{'robot': Robot\(\), 'print': student_print, '__builtins__': real_builtins\}/);
  assert.match(worker, /activeRealPlan = realPlan[\s\S]*pyodide\.runPythonAsync\(runtime\)[\s\S]*if \(realPlan\?\.error\) throw realPlan\.error[\s\S]*activeRealPlan = null[\s\S]*for \(const action of realPlan\.actions\)/);
  assert.match(worker, /runProgram\(message\.source, message\.target\)/);

  const runSource = functionSource("runProgram");
  assert.match(runSource, /if \(target === "sim"\) \{[\s\S]*startCompetitionRun/);
  assert.match(runSource, /if \(target === "sim"\) \{[\s\S]*finishCompetitionRun/);
  assert.match(runSource, /target === "real"[\s\S]*本次不创建比赛场次、不保存成绩/);
  assert.match(app, /targetSelect\.value = "sim";[\s\S]*setRunTarget\("sim", \{ announce: false \}\)/);
  assert.match(app, /visibilitychange[\s\S]*stopRealCameraPreview[\s\S]*sendRealRobotStop/);
  assert.match(app, /pagehide[\s\S]*stopRealCameraPreview[\s\S]*cancelPythonCollection\("page_hidden"\)[\s\S]*sendRealRobotStop/);
  assert.match(app, /let realStopPromise = null;[\s\S]*if \(realStopPromise\) return realStopPromise/);
  assert.match(app, /parsed\.pathname !== "\/" \|\| parsed\.search \|\| parsed\.hash/);
  assert.match(app, /const REAL_DRIVE_CM_PER_SECOND = 15\.625/);
  assert.match(app, /initializeSimulationVision\(\);/);
  assert.doesNotMatch(app, /updateVisionTemplateLibrary\s*\(/);
});

test("authentication pages use the server's HttpOnly session without browser credential storage", () => {
  assert.match(loginHtml, /id="loginForm"/);
  assert.match(loginHtml, /id="registerForm"/);
  assert.match(loginHtml, /<script\s+src="\.\/auth\.js(?:\?[^\"]*)?"/);
  assert.match(authClient, /\/api\/v1\/auth\/login/);
  assert.match(authClient, /\/api\/v1\/auth\/register/);
  assert.match(authClient, /credentials:\s*["']same-origin["']/);
  assert.match(loginHtml, /id="registerTeamAction"[^>]*name="teamAction"/);
  assert.match(loginHtml, /<option value="create" selected>创建新队伍<\/option>/);
  assert.match(loginHtml, /<option value="join">加入已有队伍<\/option>/);
  assert.match(loginHtml, /id="registerTeamName"[^>]*name="teamName"[^>]*maxlength="64"[^>]*required/);
  assert.match(loginHtml, /id="registerInviteCode"[^>]*name="inviteCode"[^>]*maxlength="11"/);
  assert.match(loginHtml, /id="teamInviteDialog"/);
  assert.match(loginHtml, /id="registerGroup"[^>]*name="group"[^>]*required/);
  assert.match(loginHtml, /value="primary"[^>]*>小学组</);
  assert.match(loginHtml, /value="junior"[^>]*>初中组</);
  assert.match(loginHtml, /value="high"[^>]*>高中组</);
  assert.match(authClient, /const body = \{ username, password: passwordInput\.value, group, teamAction \}/);
  assert.match(authClient, /body\.teamName\s*=\s*teamName/);
  assert.match(authClient, /body\.inviteCode\s*=\s*inviteCode/);
  assert.match(authClient, /showTeamInviteDialog\(payload\.teamInviteCode, payload\.user\)/);
  assert.match(authClient, /syncTeamRegistrationMode/);
  assert.doesNotMatch(loginHtml,
    /Semifinal Simulation Workspace|让每次调试|三维仿真|记录存证|成绩回看|authoritative:\s*false/,
    "the authentication page must stay focused on account access instead of a marketing introduction");
  assert.match(loginHtml, /<main class="auth-page">[\s\S]*?<section class="auth-panel-wrap"/);
  assert.doesNotMatch(loginHtml, /class="auth-story"/);
  assert.match(cssRule(".auth-page", accountCss), /place-items:\s*center/);
  assert.match(cssRule(".auth-panel-wrap", accountCss), /width:\s*min\(430px,\s*100%\)/);
  assert.match(authGuard, /name\.textContent\s*=\s*user\.teamName\s*\|\|\s*user\.username/,
    "the account header must render the team name with a legacy username fallback via textContent");
  assert.equal((loginHtml.match(/pattern="\[A-Za-z0-9\]\[A-Za-z0-9\._\\-\]\{2,31\}"/g) || []).length, 2,
    "Chrome's Unicode-set pattern parser requires the username hyphen to be escaped");

  const credentialClients = [authClient, authGuard, recordsClient, adminClient].join("\n");
  assert.doesNotMatch(credentialClients, /\b(?:localStorage|sessionStorage)\b/);
  assert.doesNotMatch(credentialClients, /document\.cookie/);
  assert.doesNotMatch(credentialClients, /Authorization\s*:\s*[`"']Bearer/i);
});

test("administrators land on a formal single-run leaderboard with identity filters and stable score modes", () => {
  const redirect = functionSource("redirectAfterAuthentication", authClient);
  assert.match(redirect, /user\?\.role\s*===\s*["']admin["'][\s\S]*returnTo\s*===\s*["']\/["'][\s\S]*["']\/admin\.html["']/,
    "an administrator returning from the protected root must land directly in the backend");
  assert.match(adminHtml, /id="adminRankedEvaluationSection"[^>]*\bhidden\b[^>]*\binert\b/,
    "the old five-run ranking must not be presented on the administrator landing page");
  for (const id of ["adminUsernameFilter", "adminTeamFilter", "adminTaskFilter", "adminScoreSort", "adminTeamRecordMode"]) {
    assert.match(adminHtml, new RegExp(`id=["']${id}["']`), `missing administrator control #${id}`);
  }
  assert.match(adminHtml, /<option value="best-per-team">每队每任务最高分<\/option>/);
  assert.match(adminHtml, /<option value="submitted-desc">最新提交优先<\/option>/);
  assert.match(adminHtml, /得分 \/ 100/);
  assert.match(functionSource("normalizeRecord", adminClient), /value\.scoreMaximum\s*!==\s*SCORE_MAXIMUM/);
  assert.match(functionSource("recordsForCurrentView", adminClient), /record\.teamGroupingKey/);
  assert.match(functionSource("compareRecords", adminClient), /Date\.parse\(right\.submittedAt\)\s*-\s*Date\.parse\(left\.submittedAt\)/,
    "latest submission sorting must use the strictly validated submittedAt field");
  assert.doesNotMatch(functionSource("renderTable", adminClient), /record\.teamId/,
    "the runtime teamId must not be rendered as the registered team name");
  const bootstrap = adminClient.slice(adminClient.lastIndexOf("Promise.resolve(globalThis.chenlongAuthReady)"));
  assert.doesNotMatch(bootstrap, /loadAdminRanking\(\)/,
    "the hidden five-run section must not request ranking data during administrator startup");
});

test("the visible administrator page is compact while retaining every operational control", () => {
  assert.match(adminHtml, /<body\s+class="admin-page">/,
    "compact administration styles must be scoped so they cannot restyle participant pages");

  const hiddenRankingStart = adminHtml.indexOf('<section id="adminRankedEvaluationSection"');
  const archiveStart = adminHtml.indexOf('<section class="archive-results-section"');
  assert.ok(hiddenRankingStart >= 0 && archiveStart > hiddenRankingStart,
    "the inert legacy ranking section must remain isolated from the visible administration page");
  const visibleAdminHtml = adminHtml.slice(0, hiddenRankingStart) + adminHtml.slice(archiveStart);

  assert.doesNotMatch(visibleAdminHtml, /\b(?:page-kicker|section-kicker|reference-badge|metric-grid|metric-card)\b/,
    "visible administration content must not use decorative kickers, badges, or dashboard-card grids");
  assert.doesNotMatch(visibleAdminHtml,
    /Competition Record Administration|ACCOUNT MANAGEMENT|FORMAL RUN ARCHIVE|ADMIN RECORD DETAIL|authoritative\s*:\s*false/,
    "visible administration copy must not expose decorative English or implementation terminology");

  const userSummary = visibleAdminHtml.match(/<section class="metric-summary" aria-label="用户概览">[\s\S]*?<\/section>/)?.[0] || "";
  const recordSummary = visibleAdminHtml.match(/<section class="metric-summary" aria-label="全局记录概览">[\s\S]*?<\/section>/)?.[0] || "";
  for (const [name, summary, metricIds] of [
    ["user", userSummary, ["adminUserMetricTotal", "adminUserMetricPrimary", "adminUserMetricJunior", "adminUserMetricHigh", "adminUserMetricAdmins"]],
    ["record", recordSummary, ["adminMetricTotal", "adminMetricUsers", "adminMetricVerified", "adminMetricAverage", "adminMetricAi"]]
  ]) {
    assert.ok(summary, `missing compact ${name} metric summary`);
    assert.doesNotMatch(summary, /<article\b|<small\b|metric-card/,
      `${name} metrics must remain a short inline summary`);
    for (const id of metricIds) assert.match(summary, new RegExp(`id=["']${id}["']`));
  }

  const operationalIds = [
    "refreshAdminUsersButton", "exportAdminUsersButton", "adminUserUsernameFilter", "adminUserTeamFilter",
    "adminUserGroupFilter", "adminUserRoleFilter", "adminUsersTableBody",
    "refreshAdminMapButton", "toggleAdminMapEditorButton", "adminMapEditorBody",
    "restoreAdminMapButton", "saveAdminMapButton", "adminMapStage", "adminMapPointList",
    "refreshAdminRecordsButton", "exportAdminRecordsButton", "adminUsernameFilter", "adminTeamFilter", "adminTaskFilter", "adminGroupFilter",
    "adminStatusFilter", "adminAutonomyModeFilter", "adminScoreSort", "adminTeamRecordMode", "adminRecordsTableBody",
    "adminRecordDetailDialog", "adminRecordDetailContent", "closeAdminRecordDetailButton"
  ];
  for (const id of operationalIds) {
    assert.equal((adminHtml.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1,
      `administrator control #${id} must be retained exactly once`);
  }
  assert.match(adminClient, /querySelector\("#refreshAdminRecordsButton"\)\.addEventListener\("click",\s*loadRecords\)/);
  assert.match(adminClient, /refreshUsersButton\.addEventListener\("click",\s*loadUsers\)/);
  assert.match(adminClient, /exportRecordsButton\.addEventListener\("click",\s*exportRecords\)/);
  assert.match(adminClient, /exportUsersButton\.addEventListener\("click",\s*exportUsers\)/);
  assert.match(functionSource("exportRecords", adminClient), /recordsForCurrentView\(\)/,
    "record export must apply all active filters, sorting, and team-best selection before it writes CSV");
  assert.match(functionSource("csvCell", adminClient), /\^\[=\+\\-@\]/,
    "CSV export must prevent spreadsheet formula interpretation for administrator data");
  assert.match(adminClient, /tableBody\.addEventListener\("click"[\s\S]*openDetail\(button\.dataset\.recordId\)/);
  assert.match(adminClient, /usersTableBody\.addEventListener\("click"[\s\S]*saveUser\(button\.dataset\.userSaveId\)/);
  assert.match(adminClient, /autonomyModeFilter\.addEventListener\("change"[\s\S]*\["all", "standard", "ai", "ai-verified"\]/,
    "AI record filtering must only accept the frozen visible modes");
  assert.match(adminClient, /AI 自主（闭环已验证）/,
    "verified visual-navigation-control loops must have an unambiguous administrator label");

  assert.match(accountCss, /\.admin-page \.metric-summary\s*\{[\s\S]*?display:\s*flex/,
    "compact summaries must have an administrator-scoped presentation");
  const narrowAdminStart = accountCss.lastIndexOf("@media (max-width: 680px)");
  const narrowAdminEnd = accountCss.indexOf("@media (max-width: 480px)", narrowAdminStart);
  const narrowAdminCss = accountCss.slice(narrowAdminStart, narrowAdminEnd);
  assert.match(narrowAdminCss, /\.admin-page \.metric-summary > span/,
    "compact summaries need a narrow-screen rule");
  assert.match(narrowAdminCss,
    /\.admin-page \.user-management-toolbar \.toolbar-search[\s\S]*\.admin-page \.admin-team-mode-select\s*\{[\s\S]*?width:\s*100%/,
    "administrator filters must become full-width on narrow screens");
});

test("administrator tools are separated into three compact keyboard-accessible tabs", () => {
  assert.match(adminHtml, /class="admin-section-tabs"[^>]*role="tablist"/);
  for (const [tabId, panelId, label] of [
    ["adminRecordsTab", "adminRecordsSection", "比赛记录"],
    ["adminUsersTab", "adminUsersSection", "用户管理"],
    ["adminMapsTab", "adminMapsSection", "地图管理"]
  ]) {
    assert.match(adminHtml, new RegExp(
      `id="${tabId}"[^>]*role="tab"[^>]*aria-controls="${panelId}"[^>]*>${label}<`
    ));
    assert.match(adminHtml, new RegExp(
      `id="${panelId}"[^>]*role="tabpanel"[^>]*aria-labelledby="${tabId}"`
    ));
  }
  assert.match(adminHtml, /id="adminUsersSection"[^>]*\bhidden\b/);
  assert.match(adminHtml, /id="adminMapsSection"[^>]*\bhidden\b/);
  assert.doesNotMatch(adminHtml.match(/<section class="archive-results-section"[^>]*>/)?.[0] || "", /\bhidden\b/);
  assert.match(functionSource("selectAdminSection", adminClient), /panel\.hidden\s*=\s*name\s*!==\s*selected/);
  assert.match(adminClient, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(accountCss, /\.admin-page \.admin-section-tab\[aria-selected="true"\]/);
});

test("formal administrator records expose one compact twenty-row paginator", () => {
  const paginationIds = [
    "adminRecordsPagination", "adminRecordsRange", "adminRecordsPageStatus",
    "adminRecordsPrevPage", "adminRecordsNextPage"
  ];
  for (const id of paginationIds) {
    assert.equal((adminHtml.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1,
      `formal-record pagination control #${id} must exist exactly once`);
  }

  const paginationMarkup = adminHtml.match(
    /<nav id="adminRecordsPagination"[\s\S]*?<\/nav>/
  )?.[0] || "";
  assert.ok(paginationMarkup, "formal-record pagination must be a dedicated navigation region");
  assert.match(paginationMarkup, /aria-label="正式提交记录分页"/);
  assert.match(paginationMarkup, /\bhidden\b/,
    "pagination must remain hidden until formal records finish loading");
  assert.match(paginationMarkup, /aria-live="polite"[^>]*aria-atomic="true"/,
    "page and range changes must be announced without interrupting the administrator");
  assert.match(paginationMarkup,
    /id="adminRecordsPrevPage"[^>]*type="button"[^>]*aria-controls="adminRecordsTableBody"[^>]*disabled/);
  assert.match(paginationMarkup,
    /id="adminRecordsNextPage"[^>]*type="button"[^>]*aria-controls="adminRecordsTableBody"[^>]*disabled/);
  assert.ok(adminHtml.indexOf('id="adminRecordsPagination"') > adminHtml.indexOf('id="adminRecordsTableBody"'),
    "formal-record pagination must follow its own table");
  const userSection = adminHtml.slice(
    adminHtml.indexOf('<section class="user-management-section"'),
    adminHtml.indexOf('<section id="adminRankedEvaluationSection"')
  );
  assert.doesNotMatch(userSection, /adminRecords(?:Pagination|Range|PageStatus|PrevPage|NextPage)/,
    "formal-record pagination controls must not be attached to user management");

  assert.match(adminClient, /const RECORDS_PER_PAGE\s*=\s*20\s*;/,
    "the formal-record page size must stay fixed at twenty rows");
  const renderer = functionSource("renderTable", adminClient);
  assert.match(renderer,
    /const visible\s*=\s*recordsForCurrentView\(\);[\s\S]*clampRecordPage\(visible\.length\)[\s\S]*visible\.slice\(pageStart,\s*pageStart\s*\+\s*RECORDS_PER_PAGE\)/,
    "filtering, team-best selection, and sorting must finish before the result is sliced into a page");
  assert.match(adminClient,
    /recordsPrevPage\?\.addEventListener\("click"[\s\S]*state\.recordPage\s*-=\s*1[\s\S]*recordsNextPage\?\.addEventListener\("click"[\s\S]*state\.recordPage\s*\+=\s*1/,
    "both bounded pagination actions must remain wired");

  assert.match(cssRule(".admin-page .records-pagination", accountCss), /display:\s*flex/,
    "the paginator needs an administrator-scoped compact layout");
  const narrowAdminStart = accountCss.lastIndexOf("@media (max-width: 680px)");
  const narrowAdminEnd = accountCss.indexOf("@media (max-width: 480px)", narrowAdminStart);
  const narrowAdminCss = accountCss.slice(narrowAdminStart, narrowAdminEnd);
  assert.match(narrowAdminCss,
    /\.admin-page \.records-pagination\s*\{[\s\S]*?flex-wrap:\s*wrap/,
    "the paginator must wrap instead of overflowing on a narrow screen");
  assert.match(narrowAdminCss,
    /\.admin-page \.records-pagination-info,[\s\S]*?\.admin-page \.records-pagination-controls\s*\{[\s\S]*?width:\s*100%/,
    "pagination information and controls must each occupy a narrow-screen row");
  assert.match(narrowAdminCss,
    /\.admin-page \.records-page-button\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*44px/,
    "previous and next actions must share the narrow-screen width and keep a touch-sized target");
});

test("administrator records include a fifteen-team three-challenge high-score summary", () => {
  for (const id of [
    "adminTeamChallengeBestBody", "adminTeamChallengeBestPagination",
    "adminTeamChallengeBestRange", "adminTeamChallengeBestPageStatus",
    "adminTeamChallengeBestPrevPage", "adminTeamChallengeBestNextPage"
  ]) {
    assert.equal((adminHtml.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1,
      `missing or duplicated team high-score control #${id}`);
  }
  assert.match(adminHtml, /各队三项最高分/);
  assert.match(adminHtml, /小组[\s\S]*任务1最高分[\s\S]*任务2最高分[\s\S]*任务3最高分[\s\S]*三项总分/);
  assert.match(adminHtml, /id="exportTeamChallengeBestButton"/);
  assert.match(adminClient, /function exportTeamChallengeBest\(\)[\s\S]*三项总分/);
  assert.match(adminHtml, /admin-team-scores\.js\?v=/);
  assert.match(adminTeamScores, /const DEFAULT_PAGE_SIZE = 15/);
  assert.match(adminTeamScores, /current === null \|\| score > current/,
    "team summary must retain the numeric maximum for each task");
  assert.match(functionSource("renderTeamChallengeBest", adminClient),
    /paginateTeamScores\(rows, state\.teamChallengeBestPage, 15\)/,
    "the rendered summary must contain at most fifteen teams per page");
  assert.ok(adminHtml.indexOf('id="adminTeamChallengeBestTitle"') > adminHtml.indexOf('id="adminRecordsPagination"'),
    "the team summary must follow the formal record table");
});

test("personal records show submitted maxima for all three tasks", () => {
  assert.match(html, /id="competitionTaskHighScores"[\s\S]*任务1[\s\S]*任务2[\s\S]*任务3/);
  assert.match(app, /buildSubmittedTaskScores\(/);
  assert.match(app, /\?limit=1000/);
  assert.match(functionSource("loadCompetitionRecordsPreview", app), /renderCompetitionTaskHighScores\(payload\.records\)/);
});

test("administrator user management exposes an independent twenty-row paginator", () => {
  for (const id of [
    "adminUsersPagination", "adminUsersRange", "adminUsersPageStatus",
    "adminUsersPrevPage", "adminUsersNextPage"
  ]) {
    assert.equal((adminHtml.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1,
      `missing or duplicated administrator user paginator control #${id}`);
  }
  const userPaginator = adminHtml.match(/<nav id="adminUsersPagination"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.match(userPaginator, /aria-label="用户管理分页"/);
  assert.match(userPaginator, /role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(userPaginator,
    /id="adminUsersPrevPage"[^>]*type="button"[^>]*aria-controls="adminUsersTableBody"[^>]*disabled/);
  assert.match(userPaginator,
    /id="adminUsersNextPage"[^>]*type="button"[^>]*aria-controls="adminUsersTableBody"[^>]*disabled/);
  assert.match(adminClient, /const USERS_PER_PAGE\s*=\s*20\s*;/);
  const renderer = functionSource("renderUsersTable", adminClient);
  assert.match(renderer,
    /const visible\s*=\s*usersForCurrentView\(\);[\s\S]*clampUserPage\(visible\.length\)[\s\S]*visible\.slice\(pageStart,\s*pageStart\s*\+\s*USERS_PER_PAGE\)/);
  for (const [control, field] of [
    ["userUsernameFilter", "userUsernameQuery"], ["userTeamFilter", "userTeamQuery"],
    ["userGroupFilter", "userGroup"], ["userRoleFilter", "userRole"]
  ]) {
    const listenerStart = adminClient.indexOf(`${control}.addEventListener`);
    assert.ok(listenerStart >= 0);
    assert.match(adminClient.slice(listenerStart, listenerStart + 420), /state\.userPage\s*=\s*1\s*;/,
      `${field} changes must reset the user page`);
  }
  assert.match(adminClient, /usersPrevPage\?\.addEventListener\("click"[\s\S]*state\.userPage\s*-=/);
  assert.match(adminClient, /usersNextPage\?\.addEventListener\("click"[\s\S]*state\.userPage\s*\+=/);
});

test("administrator map configuration is a compact folded, versioned, accessible editor", () => {
  assert.match(adminHtml,
    /id="toggleAdminMapEditorButton"[^>]*aria-expanded="false"[^>]*aria-controls="adminMapEditorBody"/,
    "the large map editor must be folded on initial administration load");
  assert.match(adminHtml, /id="adminMapEditorBody"\s+hidden/);
  assert.match(adminHtml,
    /id="adminMapImage"[^>]*src="\.\/word\/广阳岛仿真沙盘地图\.png"[^>]*width="1387"[^>]*height="860"/,
    "the editor must preview the existing Guangyang source map at its natural aspect ratio");
  for (const id of [
    "adminMapVersion", "adminMapRevision", "adminMapUpdatedAt", "adminMapNotice",
    "adminMapStage", "adminMapMarkers", "adminMapPointList", "restoreAdminMapButton", "saveAdminMapButton"
  ]) {
    assert.equal((adminHtml.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1,
      `missing or duplicated administrator map control #${id}`);
  }
  for (const label of ["途径点", "目标物", "目标点（存放点）", "混淆物", "障碍物"]) {
    assert.match(adminClient, new RegExp(label.replace(/[（）]/g, value => `\\${value}`)),
      `the map editor must expose ${label}`);
  }
  assert.match(adminClient, /const MAP_CONFIG_ENDPOINT\s*=\s*"\/api\/v1\/admin\/map-config"/);
  assert.match(adminHtml, /id="adminMapChallengeSelect"[^>]*aria-label="选择要编辑的广阳岛任务地图"/);
  assert.match(adminHtml, /id="adminMapVariantSelect"[^>]*aria-label="选择要编辑的地图编号"/);
  assert.match(adminHtml, /id="adminMapAssignmentTableBody"/);
  assert.match(adminHtml, /<option value="R2-GYI-MVP-01">广阳岛综合任务1（基础）<\/option>/);
  assert.match(adminHtml, /<option value="R2-GYI-MVP-02">广阳岛综合任务2（进阶）<\/option>/);
  assert.match(adminHtml, /<option value="R2-GYI-MVP-03">广阳岛综合任务3（高级）<\/option>/);
  assert.match(adminClient, /function mapConfigEndpoint\(taskId\s*=\s*state\.mapTaskId,\s*variant\s*=\s*state\.mapVariantId\)/);
  assert.match(adminClient, /\$\{MAP_CONFIG_ENDPOINT\}\/\$\{encodeURIComponent\(taskId\)\}\/\$\{encodeURIComponent\(variant\)\}/);
  assert.match(adminClient, /mapChallengeSelect\?\.addEventListener\(["']change["']/);
  assert.match(adminClient, /mapVariantSelect\?\.addEventListener\(["']change["']/);
  assert.match(adminClient, /chenlong\.guangyang-map-pools-admin\/v1/);
  assert.match(adminClient, /const MAP_UPDATE_SCHEMA_VERSION\s*=\s*"chenlong\.guangyang-map-config-update\/v1"/);
  assert.match(functionSource("saveMapConfig", adminClient),
    /method:\s*"PUT"[\s\S]*schemaVersion:\s*MAP_UPDATE_SCHEMA_VERSION[\s\S]*baseRevision:\s*baseEnvelope\.revision[\s\S]*layout/,
    "publishing must use a version-checked exact update body");
  assert.match(functionSource("requestJson", adminClient), /credentials:\s*"same-origin"/);
  assert.match(functionSource("validateMapConfigResponse", adminClient),
    /hasExactKeys\(payload,[\s\S]*"revision"[\s\S]*"digest"[\s\S]*"layout"/,
    "map responses must fail closed on unknown or missing envelope fields");
  assert.match(functionSource("normalizeMapLayout", adminClient),
    /hasExactKeys\(value, \["schemaVersion", "checkpoints", "targets", "storage", "distractors", "obstacles"\]\)/);
  const editorBuilder = functionSource("createMapEditor", adminClient);
  assert.match(editorBuilder, /pointerdown[\s\S]*pointermove/,
    "all challenge markers must support pointer dragging");
  assert.match(editorBuilder, /ArrowLeft[\s\S]*ArrowRight[\s\S]*ArrowUp[\s\S]*ArrowDown/,
    "all challenge markers must support keyboard micro-adjustment");
  assert.match(adminClient, /MAP_LIMITS\s*=\s*Object\.freeze\(\{ x:[\s\S]*\[-20, 20\][\s\S]*z:[\s\S]*\[-12, 12\]/);
  assert.match(adminClient, /mapOperationId[\s\S]*operationId !== state\.mapOperationId/,
    "stale map responses must not replace a newer operation");
  assert.match(cssRule(".admin-page .map-config-workspace", accountCss), /display:\s*grid/);
  assert.doesNotMatch(cssRule(".admin-page .map-config-panel", accountCss), /gradient|box-shadow/,
    "the map editor must retain the plain compact administration style");
  const narrowAdminStart = accountCss.lastIndexOf("@media (max-width: 680px)");
  const narrowAdminEnd = accountCss.indexOf("@media (max-width: 480px)", narrowAdminStart);
  assert.match(accountCss.slice(narrowAdminStart, narrowAdminEnd),
    /\.admin-page \.map-config-workspace\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
    "the editor must become a single column on narrow screens");
});

test("every protected page loads the authentication guard before application code", () => {
  for (const [name, source] of [["index", html], ["records", recordsHtml], ["admin", adminHtml]]) {
    const guardIndex = source.indexOf("./auth-guard.js");
    assert.ok(guardIndex >= 0, `${name} page must load auth-guard.js`);
    const applicationScripts = [...source.matchAll(/<script\s+src="(\.\/(?:app|records|admin)\.js)(?:\?[^\"]*)?"/g)];
    assert.equal(applicationScripts.length, 1, `${name} page must load one application client`);
    assert.ok(guardIndex < applicationScripts[0].index, `${name} page must load its guard first`);
  }
  assert.match(authGuard, /\/api\/v1\/auth\/me/);
  assert.match(authGuard, /credentials:\s*["']same-origin["']/);
  assert.match(authGuard, /value\.startsWith\(["']\/["']\)\s*&&\s*!value\.startsWith\(["']\/\/["']\)/);
  assert.match(authClient, /!value\.startsWith\(["']\/["']\)\s*\|\|\s*value\.startsWith\(["']\/\/["']\)/);
  assert.match(html, /id="adminNavLink"[^>]*hidden/,
    "the workspace administration link must start hidden until an administrator is verified");
  assert.match(html, /id="teamInviteButton"[^>]*hidden[^>]*aria-controls="teamInviteDialog"/,
    "the workspace must provide a hidden-until-authenticated team invite entry");
  assert.match(html, /<dialog id="teamInviteDialog"[^>]*aria-labelledby="teamInviteDialogTitle"/);
  assert.match(html, /id="copyTeamInviteButton"[^>]*disabled/);
  assert.match(cssRule("#adminNavLink[hidden]"), /display:\s*none\s*!important/,
    "normal users must not see the administration link when navigation styles are applied");
  assert.match(authGuard, /adminLink\.hidden\s*=\s*user\.role\s*!==\s*["']admin["']/,
    "only a verified administrator may reveal the administration link");
  assert.match(authGuard, /const TEAM_INVITE_ENDPOINT\s*=\s*["']\/api\/v1\/auth\/team-invite["']/);
  assert.match(functionSource("parseTeamInvite", authGuard), /schemaVersion\s*!==\s*["']chenlong\.team-invite\/v1["']/,
    "the invite response must be strictly validated before it reaches the dialog");
  assert.match(functionSource("openTeamInvite", authGuard), /credentials:\s*["']same-origin["']/);
  assert.match(functionSource("copyTeamInvite", authGuard), /navigator\.clipboard\?\.writeText/);
  assert.match(functionSource("renderAccount", authGuard), /installTeamInviteControl\(user\)/);
  assert.match(css, /\.team-invite-dialog\s*\{/);
});

test("archived replay uses bounded latest lookup, byte digests, and the shared auth redirect", () => {
  assert.match(authGuard, /globalThis\.chenlongRedirectToLogin\s*=\s*redirectToLogin/);
  assert.match(functionSource("handleCompetitionAuthenticationFailure"), /chenlongRedirectToLogin\(["']authentication-required["']\)/);
  assert.match(functionSource("requestVerificationEndpoint"), /handleCompetitionAuthenticationFailure\(response\)/);
  assert.match(functionSource("loadLatestArchivedCompetitionRecord"), /PERSONAL_RECORDS_ENDPOINT\}\?limit=1/);
  const requester = functionSource("requestArchivedRunRecord");
  assert.match(requester, /x-content-sha256/i);
  assert.match(requester, /recordSha256/);
  assert.match(requester, /sha256Hex\(buffer\)/);
});

test("the personal records page refreshes after returning from a simulation tab or bfcache", () => {
  assert.match(recordsClient, /addEventListener\(["']pageshow["'][\s\S]{0,100}event\.persisted[\s\S]{0,60}loadRecords\(\)/);
  assert.match(recordsClient, /addEventListener\(["']visibilitychange["'][\s\S]{0,100}!document\.hidden[\s\S]{0,60}loadRecords\(\)/);
  assert.match(recordsClient, /cache:\s*["']no-store["']/);
});

test("all record lists distinguish deterministic coverage from the visual recomputation scope", () => {
  assert.match(functionSource("verificationStatusLabel"), /deterministicStatus\s*===\s*["']incomplete["']/);
  assert.match(functionSource("verificationStatusLabel"), /旧版校验不完整/);
  assert.match(functionSource("renderCompetitionRecordsList"), /visionStatus\s*===\s*["']not_recomputed["']/);
  assert.match(functionSource("renderCompetitionRecordsList"), /视觉未重算/);
  for (const client of [adminClient]) {
    assert.match(functionSource("statusLabel", client), /deterministicStatus\s*===\s*["']incomplete["']/);
    assert.match(functionSource("statusLabel", client), /旧版校验不完整/);
    assert.match(functionSource("verificationStatusNode", client), /visionStatus\s*===\s*["']not_recomputed["']/);
    assert.match(functionSource("verificationStatusNode", client), /视觉未重算/);
    assert.match(client, /detailItem\(["']确定性校验范围["']/);
    assert.match(client, /detailItem\(["']视觉校验范围["']/);
  }
  assert.match(recordsClient, /recordState\s*===\s*["']saved["']/);
  assert.match(recordsClient, /提交后自动校验/);
  assert.match(recordsClient, /\/submit/);
  assert.match(recordsHtml, /<option value="saved">待提交<\/option>/);
  assert.match(recordsHtml, /<option value="submitted">已提交<\/option>/);
  assert.match(adminHtml, /<option value="partial">校验不完整（含旧版）<\/option>/);
  assert.match(accountCss, /\.verification-scope-hint\s*\{/);
  assert.match(css, /\.workspace-record-scope-hint\s*\{/);
});

test("competition mission is selectable and Python runtime is fully local", () => {
  const sceneSelect = /<select id="sceneSelect"[\s\S]*?<\/select>/.exec(html)?.[0] || "";
  assert.deepEqual([...sceneSelect.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), [
    "guangyang", "guangyang2", "guangyang3"
  ]);
  assert.doesNotMatch(app, /任务：巡逻送包裹|任务：视觉识别练习|任务：自由练习|大型任务：智慧物流中心/);
  assert.match(app, /loadMission\("guangyang"\)/);
  assert.doesNotMatch(worker, /oss\.opencamp\.cn|https:\/\//);
  ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip"].forEach(file => {
    assert.equal(fs.existsSync(path.join(root, "vendor", "pyodide", file)), true, file);
  });
  assert.equal(fs.existsSync(path.join(root, core.GUANGYANG_ISLAND_CONFIG.world.sourceImage.path)), true);
});

test("competition lifecycle schedules telemetry and preserves explicit stop reasons", () => {
  const starter = functionSource("startCompetitionRun");
  assert.match(app, /setInterval\(\(\) => competitionTick\(\), 100\)/);
  assert.match(app, /cancelPythonCollection\("stopped"\)/);
  assert.match(app, /recordCompetitionManualInput\("stop", \{ control: "stop_button" \}\)/);
  assert.match(functionSource("recordCompetitionManualInput"), /competitionSession\.addManualInput\(action, inputDetail\)/);
  assert.match(starter, /runDefinition:\s*\{[\s\S]*visionDefinition:\s*globalThis\.CompetitionCore\.VISION_DEFINITION/);
  assert.match(starter, /client_watchdog/);
  assert.doesNotMatch(starter, /finish\(["']timeout["']\)/, "wall-clock timers must not decide deterministic timeouts");
});

test("competition HUD distinguishes a retained previous result from a reset task", () => {
  const renderer = functionSource("renderCompetitionHud");
  const starter = functionSource("startCompetitionRun");
  const resetStart = app.indexOf('document.querySelector("#resetButton").addEventListener("click", async () => {');
  const resetEnd = app.indexOf("exportRunRecordButton?.addEventListener", resetStart);
  const resetHandler = resetStart >= 0 && resetEnd > resetStart ? app.slice(resetStart, resetEnd) : "";

  assert.match(html, /id="competitionRunState"[^>]*data-state="idle"[^>]*aria-live="polite"/);
  assert.match(css, /\.competition-run-state\[data-state="previous"\]/);
  assert.match(renderer, /runInProgress\s*\?\s*["']计时运行中["']/);
  assert.match(renderer, /runInProgress\s*\?\s*["']running["']/);
  assert.match(resetHandler, /latestCompetitionRecord[\s\S]*renderCompetitionHud\(latestCompetitionRecord\.result,\s*true\)[\s\S]*setCompetitionRunState\(["']上一局结果["'],\s*["']previous["']\)/);
  assert.match(starter, /setCompetitionRecordActionStatus\(["']record["'],\s*["']warning["'],\s*["']比赛场次准备已取消["']\)/);
});

test("competition task progress comes from the core TaskEngine", () => {
  const tick = functionSource("competitionTick");
  const taskConsumer = functionSource("consumeCompetitionTaskResult");
  const localEvaluator = functionSource("evaluateMissionProgress");
  const finisher = functionSource("finishCompetitionRun");
  const completion = functionSource("completeMissionAttempt");

  assert.match(tick, /consumeCompetitionTaskResult\(result\)/);
  assert.match(tick, /latestCompetitionRecord\?\.result \|\| result\.record\?\.result/);
  assert.match(taskConsumer, /applyMissionTaskState\(result\.taskState\)/);
  assert.match(taskConsumer, /result\.taskEvents/);
  assert.match(taskConsumer, /alreadySampled: true/);
  assert.match(localEvaluator, /isCompetitionMission\(\) && competitionSession/);
  assert.match(localEvaluator, /taskEngine\.evaluate\(/);
  assert.doesNotMatch(app, /competitionSession\.updateTask\(/);
  assert.doesNotMatch(app, /recordCompetitionEvent\("checkpoint"/);
  assert.doesNotMatch(app, /recordCompetitionEvent\("task_completed"/);
  assert.match(finisher, /competitionFinishInProgress = true/);
  assert.match(finisher, /finally \{/);
  assert.match(completion, /alreadySampled && competitionSession\?\.status === "running"/);
  assert.match(app, /recordCompetitionEvent\("package_grabbed"[\s\S]{0,220}competitionTick\(true\)/);
  assert.match(app, /recordCompetitionEvent\("package_released"[\s\S]{0,320}competitionTick\(true\)/);
  assert.match(app, /stoppedRecord\?\.result\?\.reason !== "completed"/);
});

test("Guangyang keeps the source map authoritative while adding a visual-only 3D relief", () => {
  const environmentBuilder = functionSource("buildGuangyangEnvironment");
  const sourceMapBuilder = functionSource("addGuangyangSourceMap");
  const sourceImageLoader = functionSource("loadGuangyangSourceImage");
  const reliefBuilder = functionSource("buildGuangyangRelief");
  const reliefTrees = functionSource("addGuangyangReliefTrees");
  const topCamera = functionSource("fitTopCameraToMap");
  const cameraSwitch = functionSource("setCameraMode");
  const orbitStart = functionSource("startOrbitDrag");
  const simulatorUiTarget = functionSource("isSimulatorUiTarget");
  const mapPlacement = functionSource("placeObjectFromClick");
  assert.match(environmentBuilder, /addGuangyangSourceMap\(config\)/);
  assert.match(environmentBuilder, /buildGuangyangRelief\(config\)/);
  assert.ok(
    environmentBuilder.indexOf("addGuangyangSourceMap(config)") < environmentBuilder.indexOf("buildGuangyangRelief(config)"),
    "the exact source map must be built before its visual relief"
  );
  assert.doesNotMatch(environmentBuilder, /addGuangyangRoadNetwork\(config\)/);
  assert.doesNotMatch(environmentBuilder, /addGuangyangLandmark/);
  assert.doesNotMatch(environmentBuilder, /createObstacleModel/);
  assert.match(sourceMapBuilder, /PlaneGeometry\(Number\(source\.widthUnits\)/);
  assert.match(sourceMapBuilder, /Number\(source\.heightUnits\)/);
  assert.match(sourceMapBuilder, /source\.bakedVehiclePatch/);
  assert.match(sourceMapBuilder, /loadGuangyangSourceImage\(textureUrl\)/);
  assert.doesNotMatch(sourceMapBuilder, /new THREE\.(?:Texture|Image)Loader\(\)/);
  assert.doesNotMatch(sourceMapBuilder, /source(?:Texture|Image)\.dispose\(\)/);
  assert.match(sourceImageLoader, /new THREE\.ImageLoader\(\)\.load\(cacheKey/);
  assert.match(reliefBuilder, /root\.userData\.visualOnly = true/);
  assert.match(reliefBuilder, /addMissionDecoration\(root, null, false\)/);
  assert.doesNotMatch(reliefBuilder, /addGuangyangReliefCurbs\(/);
  assert.match(reliefTrees, /crowns\.castShadow\s*=\s*false/);
  assert.match(reliefTrees, /crownHighlights\.castShadow\s*=\s*false/);
  assert.match(functionSource("updateGuangyangReliefVisibility"), /cameraMode !== "top"/);
  assert.match(cameraSwitch, /updateGuangyangReliefVisibility\(\)/);
  assert.match(orbitStart, /updateGuangyangReliefVisibility\(\)/);
  assert.match(simulatorUiTarget, /button[\s\S]*\.competition-hud[\s\S]*\.mission-card/);
  assert.ok(
    orbitStart.indexOf("isSimulatorUiTarget(event.target)") < orbitStart.indexOf("setPointerCapture"),
    "simulator overlays must be rejected before pointer capture"
  );
  assert.ok(
    mapPlacement.indexOf("isSimulatorUiTarget(event.target)") < mapPlacement.indexOf("placeMode"),
    "simulator overlays must be rejected before map placement"
  );
  assert.match(topCamera, /currentMapWidth\(\)/);
  assert.match(topCamera, /currentMapDepth\(\)/);
  assert.match(app, /obstacles: \(GUANGYANG_CONFIG\?\.obstacles \|\| \[\]\)/);
  assert.equal(core.GUANGYANG_ISLAND_CONFIG.world.sourceImage.widthUnits, 40);
  assert.equal(core.GUANGYANG_ISLAND_CONFIG.world.sourceImage.heightUnits, 24);
  assert.equal(core.GUANGYANG_ISLAND_CONFIG.trafficLights.length, 0);
  assert.equal(core.GUANGYANG_ISLAND_CONFIG.obstacles.length, 0);
});

test("Guangyang source image loading shares concurrent work and retries after failures", async () => {
  const source = functionSource("loadGuangyangSourceImage");
  const pendingLoads = [];
  const THREE = {
    ImageLoader: class {
      load(url, onLoad, _onProgress, onError) {
        pendingLoads.push({ url, onLoad, onError });
      }
    }
  };
  const cache = new Map();
  const loadSourceImage = Function(
    "THREE",
    "guangyangSourceImagePromises",
    `"use strict"; ${source}; return loadGuangyangSourceImage;`
  )(THREE, cache);

  const first = loadSourceImage("https://example.test/map.png");
  const concurrent = loadSourceImage("https://example.test/map.png");
  assert.equal(first, concurrent);
  assert.equal(pendingLoads.length, 1);
  const decodedImage = { width: 1418, height: 882 };
  pendingLoads[0].onLoad(decodedImage);
  assert.equal(await first, decodedImage);
  assert.equal(await concurrent, decodedImage);
  assert.equal(await loadSourceImage("https://example.test/map.png"), decodedImage);
  assert.equal(pendingLoads.length, 1, "a fulfilled source image must remain cached for scene rebuilds");

  const failed = loadSourceImage("https://example.test/missing.png");
  assert.equal(pendingLoads.length, 2);
  pendingLoads[1].onError(new Error("network failed"));
  await assert.rejects(failed, /network failed/);
  const retry = loadSourceImage("https://example.test/missing.png");
  assert.equal(pendingLoads.length, 3, "a rejected source image load must be evicted before retry");
  const recoveredImage = { width: 1, height: 1 };
  pendingLoads[2].onLoad(recoveredImage);
  assert.equal(await retry, recoveredImage);
});

test("Guangyang terrain flood-fills exterior water and keeps road corridors flat", () => {
  const terrainBuilder = functionSource("createGuangyangTerrainMesh");

  assert.match(terrainBuilder, /const segmentsX\s*=\s*128/);
  assert.match(terrainBuilder, /const segmentsZ\s*=\s*76/);
  assert.match(terrainBuilder, /new THREE\.PlaneGeometry\(width,\s*depth,\s*segmentsX,\s*segmentsZ\)/);
  assert.match(terrainBuilder, /const weakWater\s*=\s*new Uint8Array\(total\)/);
  assert.match(terrainBuilder, /const strongWater\s*=\s*new Uint8Array\(total\)/);
  assert.match(terrainBuilder, /inSeedRim\s*&&\s*strongWater\[index\]/);
  assert.match(terrainBuilder, /while\s*\(queueStart\s*<\s*queueEnd\)/);
  assert.match(terrainBuilder, /exteriorWater\[neighbor\]\s*\|\|\s*!weakWater\[neighbor\]/);

  assert.match(terrainBuilder, /distanceToPolyline\?\.\(\[worldX,\s*worldZ\],\s*road\.points\)/);
  assert.match(terrainBuilder, /distance\s*<=\s*\(Number\(road\.width\)\s*\|\|\s*0\)\s*\/\s*2/);
  assert.match(terrainBuilder, /if\s*\(roadSurface\[index\]\)\s*{\s*next\[index\]\s*=\s*1/);
  assert.match(terrainBuilder, /const value\s*=\s*roadSurface\[index\]\s*\?\s*1\s*:/);
  assert.match(terrainBuilder, /surfaceBump[\s\S]{0,100}!roadSurface\[index\]/);

  assert.match(terrainBuilder, /terrain\.castShadow\s*=\s*false/);
  assert.match(terrainBuilder, /terrain\.receiveShadow\s*=\s*false/);
  assert.match(terrainBuilder, /terrain\.userData\.visualOnly\s*=\s*true/);
});

test("Guangyang switches between the flat source map and terrain by camera view", () => {
  const visibility = functionSource("updateGuangyangReliefVisibility");

  assert.match(visibility, /reliefVisible\s*=\s*active\s*&&\s*cameraMode\s*!==\s*["']top["']/);
  assert.match(visibility, /guangyangReliefRoot\.visible\s*=\s*reliefVisible/);
  assert.match(visibility, /flatMapVisible\s*=\s*active\s*&&\s*\(!reliefVisible\s*\|\|\s*!guangyangTerrainMesh\)/);
  assert.match(visibility, /guangyangFlatMapPlane\.visible\s*=\s*flatMapVisible/);
});

test("Guangyang iso framing uses its rectangular bounds and refits after renderer resize", () => {
  const isoCamera = functionSource("fitIsoCameraToMap");
  const cameraSwitch = functionSource("setCameraMode");
  const rendererResize = functionSource("resizeRendererNow");

  assert.match(isoCamera, /currentMapWidth\(\)/);
  assert.match(isoCamera, /currentMapDepth\(\)/);
  assert.match(isoCamera, /camera\.aspect/);
  assert.match(cameraSwitch, /mode === ["']iso["'][\s\S]*fitIsoCameraToMap\(\)/);
  assert.match(rendererResize, /cameraMode === ["']iso["']\)\s*fitIsoCameraToMap\(\)/);
});

test("checkpoint rule boundaries show the configured radius without becoming colliders", () => {
  const checkpointBuilder = functionSource("createMazeCheckpoint");

  assert.match(checkpointBuilder, /activeMission\?\.completion\?\.checkpointRadius/);
  assert.match(checkpointBuilder, /new THREE\.RingGeometry\([\s\S]*visualRadius/);
  assert.match(checkpointBuilder, /ruleBoundary\.userData\.visualOnly\s*=\s*true/);
  assert.match(checkpointBuilder, /group\.add\(ruleBoundary\)/);
  assert.match(checkpointBuilder, /addMissionDecoration\(group,\s*null,\s*false\)/);
  assert.doesNotMatch(checkpointBuilder, /missionWallColliders\.push/);
});

test("competition controls stay compact, readable, and accessible", () => {
  const hudVisibility = functionSource("setCompetitionHudVisibility");
  const cameraSwitch = functionSource("setCameraMode");
  const orbitStart = functionSource("startOrbitDrag");
  const cameraButtons = [...html.matchAll(/<button\b[^>]*\bdata-view=["']([^"']+)["'][^>]*>/g)];

  assert.match(hudVisibility, /toggleSceneTools\.hidden\s*=\s*guangyangMap/);
  assert.match(hudVisibility, /sceneTools\?\.classList\.add\(["']is-collapsed["']\)/);
  assert.match(cssRule("#toggleSceneTools[hidden]"), /display\s*:\s*none/);
  assert.match(html, /<button\b[^>]*\bid=["']stopRankedEvaluationButton["'][^>]*\bhidden\b[^>]*>/);
  assert.match(html, /<button\b[^>]*\bid=["']stopCompetitionBatchButton["'][^>]*\bhidden\b[^>]*>/);
  assert.match(html, /class="score-reference-note">仅供参考<br>最终成绩以后台计算为准<\/small>/);
  assert.match(
    css,
    /#stopRankedEvaluationButton\[hidden\]\s*,\s*#stopCompetitionBatchButton\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important\s*;/
  );

  assert.deepEqual(cameraButtons.map(match => match[1]).sort(), ["follow", "iso", "top"]);
  cameraButtons.forEach(match => assert.match(match[0], /\baria-pressed=["'](?:true|false)["']/));
  assert.match(cameraSwitch, /setAttribute\(["']aria-pressed["'],\s*String\(active\)\)/);
  assert.match(orbitStart, /setAttribute\(["']aria-pressed["'],\s*["']false["']\)/);

  assert.ok(Math.min(...cssPixelValues(".competition-hud", "width")) >= 240);
  [".competition-score-grid span", ".competition-hud p", ".competition-hud button"].forEach(selector => {
    assert.ok(cssPixelValues(selector, "font-size")[0] >= 10, `${selector} text must remain readable`);
  });
  assert.ok(cssPixelValues(".competition-hud button", "min-height")[0] >= 34);
  assert.doesNotMatch(cssRule(".competition-record-actions .server-verify-button"), /grid-column\s*:/);
  assert.doesNotMatch(cssRule(".competition-record-actions .server-submit-button"), /grid-column\s*:/);
});

test("the initial and reset workspace give the simulator sixty percent of the available width", () => {
  const defaultWidth = functionSource("defaultRightPanelWidth");
  const splitter = functionSource("initWorkspaceSplitter");

  assert.match(defaultWidth, /workspaceGrid\?\.getBoundingClientRect\?\.\(\)\.width/);
  assert.match(defaultWidth, /gridWidth\s*\*\s*0\.6\b/);
  assert.match(splitter, /else\s+setRightPanelWidth\(defaultRightPanelWidth\(\),\s*false\)/);
  assert.match(splitter, /["']dblclick["'][\s\S]{0,100}setRightPanelWidth\(defaultRightPanelWidth\(\)\)/);
});

test("competition simulation vision is captured by a 640x480 robot-mounted camera", () => {
  const initializer = functionSource("initVirtualCamera");

  assert.ok(/const VIRTUAL_CAMERA_WIDTH\s*=\s*640/.test(app), "virtual camera width must be 640 pixels");
  assert.ok(/const VIRTUAL_CAMERA_HEIGHT\s*=\s*480/.test(app), "virtual camera height must be 480 pixels");
  assert.match(
    initializer,
    /new THREE\.PerspectiveCamera\([\s\S]*VIRTUAL_CAMERA_WIDTH\s*\/\s*VIRTUAL_CAMERA_HEIGHT/
  );
  assert.match(
    initializer,
    /new THREE\.WebGLRenderTarget\(\s*VIRTUAL_CAMERA_WIDTH\s*,\s*VIRTUAL_CAMERA_HEIGHT/
  );
  assert.ok(/robotGroup\.add\(virtualCamera\)/.test(app), "the virtual camera must inherit the robot transform");
  assert.match(initializer, /virtualCamera\.position\.set\(/);
});

test("virtual camera capture reads RGB pixels, flips WebGL rows, and restores renderer state", () => {
  const capture = functionSource("captureVirtualCameraFrame");
  const labelFactory = functionSource("createTextLabel");

  assert.match(capture, /renderer\.getRenderTarget\(\)/);
  assert.match(capture, /renderer\.setRenderTarget\(virtualCameraTarget\)/);
  const targetSection = capture.slice(
    capture.indexOf("renderer.setRenderTarget(virtualCameraTarget)"),
    capture.indexOf("renderer.render(scene, virtualCamera)")
  );
  assert.doesNotMatch(targetSection, /renderer\.set(?:Viewport|Scissor)\(/,
    "the render target owns its pixel viewport; screen DPR must not crop the virtual camera");
  assert.match(capture, /renderer\.readRenderTargetPixels\(/);
  assert.match(
    capture,
    /(?:VIRTUAL_CAMERA_HEIGHT|height)\s*-\s*1\s*-\s*(?:y|row)|(?:VIRTUAL_CAMERA_HEIGHT|height)\s*-\s*(?:y|row)\s*-\s*1/
  );
  assert.match(capture, /putImageData\(/);
  assert.match(capture, /finally\s*\{/);
  assert.match(capture, /const flatMapWasVisible\s*=\s*guangyangFlatMapPlane\?\.visible/);
  assert.match(capture, /guangyangFlatMapPlane\s*&&\s*guangyangTerrainMesh[\s\S]{0,100}guangyangFlatMapPlane\.visible\s*=\s*false/);
  const finallyIndex = capture.indexOf("finally {");
  const flatMapRestoreIndex = capture.indexOf("guangyangFlatMapPlane.visible = flatMapWasVisible");
  assert.ok(finallyIndex >= 0 && flatMapRestoreIndex > finallyIndex, "flat source-map visibility must be restored in finally");
  assert.match(
    capture,
    /renderer\.setRenderTarget\(\s*(?:previous|prior|saved|old)[A-Za-z0-9_]*\s*\)/i
  );
  assert.match(capture, /CarVision(?:\?\.|\.)analyzeFrame(?:\?\.)?\(/);
  assert.match(labelFactory, /hideFromVirtualCamera\s*=\s*true/,
    "screen-facing scene labels must be excluded from camera evidence");
  assert.match(capture, /scene\.traverse\([\s\S]*hideFromVirtualCamera[\s\S]*object\.visible\s*=\s*false/);
  assert.match(capture, /finally\s*\{[\s\S]*hiddenCameraOverlays\.forEach\([\s\S]*object\.visible\s*=\s*true/,
    "camera-only overlays must be restored even if capture fails");
});

test("object-training camera workbench copies evidence pixels into a private responsive overlay", () => {
  [
    "trainingVisionWorkbench",
    "trainingVisionCanvas",
    "trainingVisionOverlay",
    "trainingVisionEmpty",
    "trainingVisionFrameLabel",
    "trainingVisionStatus"
  ].forEach(id => assert.match(html, new RegExp(`id=["']${id}["']`)));
  assert.match(html, /id=["']trainingVisionWorkbench["'][^>]*\bhidden\b/);
  assert.match(html, /id=["']trainingVisionCanvas["'][^>]*role=["']img["']/);
  assert.match(html, /id=["']trainingVisionStatus["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);

  const visibility = functionSource("syncTrainingVisionWorkbenchVisibility");
  const mapper = functionSource("mapVirtualDetectionBoxToSource");
  const renderer = functionSource("renderTrainingVisionWorkbenchFrame");
  const capture = functionSource("captureVirtualCameraFrame");
  const evidence = functionSource("addCompetitionVisionEvidence");
  const invalidator = functionSource("invalidateVirtualCameraFrame");
  assert.match(functionSource("isObjectTrainingMission"), /environment\s*===\s*["']guangyang["'][\s\S]*trainingOnGuangyang\s*===\s*true/);
  assert.match(visibility, /trainingVisionWorkbench\.hidden\s*=\s*!visible/);
  assert.match(visibility, /dataset\.sceneId/);
  assert.match(mapper, /transform\.padX/);
  assert.match(mapper, /transform\.padY/);
  assert.match(mapper, /transform\.scale/);
  assert.match(mapper, /leftPercent[\s\S]*topPercent[\s\S]*widthPercent[\s\S]*heightPercent/);
  assert.match(renderer, /window\.devicePixelRatio/);
  assert.match(renderer, /TRAINING_VISION_PREVIEW_MAX_DPR/);
  assert.match(renderer, /previewContext\.drawImage\(sourceCanvas/);
  assert.match(renderer, /trainingVisionOverlay\?\.replaceChildren\(\.\.\.boxNodes\)/);
  assert.match(renderer, /dataset\.category[\s\S]*presentation\.confidence[\s\S]*presentation\.distance/);
  assert.doesNotMatch(renderer, /sourceCanvas\.(?:getContext|putImageData|fillRect|strokeRect)\s*\(/,
    "the evidence source canvas must never receive preview drawing or annotations");
  assert.doesNotMatch(renderer, /detection\?*\.id\b|world|position\.(?:x|z)/i,
    "training annotations must not expose scene IDs or world coordinates");
  assert.ok(
    capture.indexOf("addCompetitionVisionEvidence") < capture.indexOf("renderTrainingVisionWorkbenchFrame"),
    "immutable competition evidence must be captured before the optional UI copy is rendered"
  );
  assert.match(evidence, /cameraDefinitionHash:\s*globalThis\.CompetitionCore\?\.CAMERA_DEFINITION_HASH/);
  assert.match(evidence, /detectorDefinitionHash:\s*globalThis\.CompetitionCore\?\.DETECTOR_DEFINITION_HASH/);
  assert.match(invalidator, /clearTrainingVisionWorkbench\(/);
  assert.match(functionSource("loadMission"), /clearTrainingVisionWorkbench\(["']正在切换训练场景/);
  assert.match(cssRule(".training-vision-viewport"), /aspect-ratio\s*:\s*4\s*\/\s*3/);
  assert.match(css, /\.training-vision-workbench\[hidden\]\s*\{[\s\S]*display:\s*none/);
});

test("object-task camera training stays on Guangyang instead of creating three extra maps", () => {
  ["objectDelivery", "obstacleAvoidance", "distractorRemoval"].forEach(id => {
    assert.doesNotMatch(html, new RegExp(`<option\\s+value=["']${id}["']`));
    assert.doesNotMatch(app, new RegExp(`\\b${id}\\s*:\\s*\\{`));
  });
  assert.match(html, /id=["']guangyangTrainingButton["'][^>]*aria-pressed=["']false["']/);
  assert.match(html, /id=["']exitGuangyangTrainingButton["']/);
  ["target", "obstacle", "distractor"].forEach(mode => {
    assert.match(html, new RegExp(`data-guangyang-training=["']${mode}["']`));
    assert.match(app, new RegExp(`\\b${mode}\\s*:\\s*Object\\.freeze\\(\\{`));
  });
  const builder = functionSource("buildGuangyangTrainingMission");
  assert.match(builder, /structuredClone\(missions\.guangyang\)/);
  assert.match(builder, /mission\.guangyangSceneConfig\s*=\s*structuredClone\(mission\.competition\?\.config\s*\|\|\s*GUANGYANG_CONFIG\)/);
  assert.match(builder, /delete mission\.competition/);
  assert.match(builder, /trainingOnGuangyang\s*=\s*true/);
  assert.match(functionSource("loadMission"),
    /isObjectTrainingMission\(\)[\s\S]*setMissionCardCollapsed\(false,\s*\{\s*persist:\s*false\s*\}\)/,
    "entering same-map camera training must expose its mode controls even when the task card was collapsed");
  assert.match(cssRule(".object-training-panel"), /pointer-events\s*:\s*auto/,
    "training controls must remain physically clickable above the simulator canvas");
  assert.match(builder, /startSource/);
  assert.match(functionSource("enterGuangyangTrainingMode"), /loadMission\(["']guangyang["'],\s*\{\s*trainingMode/);
  assert.match(functionSource("exitGuangyangTrainingMode"), /loadMission\(["']guangyang["']\)/);
  assert.match(functionSource("currentGuangyangSceneConfig"),
    /activeMission\?\.competition\?\.config\s*\|\|\s*activeMission\?\.guangyangSceneConfig/);
  assert.match(functionSource("currentMapWidth"), /currentGuangyangSceneConfig\(\)\?\.world\?\.width/);
  assert.match(functionSource("currentMapDepth"), /currentGuangyangSceneConfig\(\)\?\.world\?\.depth/);
  assert.match(functionSource("buildGuangyangEnvironment"), /const config\s*=\s*currentGuangyangSceneConfig\(\)/,
    "camera training must build the same source map and relief without enabling competition sessions");
  ["objectTrainingPanel", "objectTrainingLegend", "objectTrainingChecklist", "objectTrainingObservations", "objectTrainingHolding"]
    .forEach(id => assert.match(html, new RegExp(`id=["']${id}["']`)));
  assert.match(app, /summary:\s*["']红色目标物 → 绿色存放点["']/);
  assert.match(app, /summary:\s*["']蓝色混淆物 → 任意道路边界外["']/);
  assert.match(builder,
    /mode\s*===\s*["']distractor["'][\s\S]*mission\.goal\s*=\s*null[\s\S]*buildGuangyangRoadClearanceTrainingCompletion/);
  const clearanceCompletion = functionSource("buildGuangyangRoadClearanceTrainingCompletion");
  assert.match(clearanceCompletion, /schemaVersion\s*!==\s*["']chenlong\.task\/v5["']/);
  assert.match(clearanceCompletion, /destinationRole\s*!==\s*["']offroad-removal["']/);
  assert.match(clearanceCompletion, /placementRule\s*!==\s*["']road-edge-clearance["']/);
  assert.match(clearanceCompletion, /placementGeometry:\s*structuredClone\(task\.placementGeometry\)/);
  assert.doesNotMatch(clearanceCompletion, /\bdestination\s*:/,
    "same-map distractor training must not restore a fixed cleanup destination");
  const localEvaluator = functionSource("evaluateMissionProgress");
  assert.match(localEvaluator, /spec\.type\s*===\s*["']offroad-removal["'][\s\S]*roadBoundaryClearance[\s\S]*minimumClearance[\s\S]*deliveredIds/,
    "same-map distractor training must judge the released object against road geometry instead of a hidden fixed zone");
  assert.match(localEvaluator,
    /heldPackageId[\s\S]*roadClearanceHandledPackageIds\.add\(heldPackageId\)[\s\S]*!missionAttempt\.roadClearanceHandledPackageIds\.has\(id\)/,
    "an off-road training placement must be gated on a successful prior grab and subsequent release");
  assert.match(functionSource("createMissionTaskEngine"),
    /spec\.type\s*===\s*["']offroad-removal["']\)\s*return null/,
    "the training-only completion type must never reach CompetitionCore.TaskEngine");
  assert.match(functionSource("initializeMissionAttempt"), /roadClearanceHandledPackageIds:\s*new Set\(\)/);
  assert.match(app, /obstacle:\s*Object\.freeze\(\{[\s\S]*?startSource:\s*Object\.freeze\(\[289,\s*424\]\)/,
    "the obstacle camera-training start must leave the full obstacle visible instead of clipping it at the lens");
  assert.match(app, /distractor:\s*Object\.freeze\(\{[\s\S]*?startSource:\s*Object\.freeze\(\[380,\s*535\]\)/,
    "the distractor camera-training start must keep the complete package inside the sensor frame");
  assert.match(functionSource("createObstacleModel"), /stoneObstacle[\s\S]*["']#64748b["'][\s\S]*DodecahedronGeometry/);
  assert.match(functionSource("createObstacleModel"),
    /warningMat\s*=\s*new THREE\.MeshBasicMaterial\(\{\s*color:\s*["']#facc15["'],\s*toneMapped:\s*false\s*\}\)/,
    "the obstacle's camera marker must keep a stable yellow independent of scene lighting");
  assert.match(functionSource("getPackageAssets"), /distractorBallMaterial[\s\S]*["']#3b82f6["']/);
  assert.match(functionSource("setCompetitionHudVisibility"), /guangyangMap[\s\S]*is-competition-locked/);
  assert.match(functionSource("rebuildSceneObjects"), /!activeMission\.trainingOnGuangyang/,
    "same-map training must reuse official object zones instead of drawing duplicate goal markers");
  assert.match(css, /\.object-training-panel\s*\{/);
  assert.match(css, /\.object-training-mode-switch\s*\{/);
  assert.match(css, /\.object-training-api\s*\{/);
  ["目标物", "障碍物", "混淆物"].forEach(category => {
    assert.match(html, new RegExp(`robot\\.observe\\(&quot;${category}&quot;\\)|robot\\.observe\\("${category}"\\)`));
  });
  assert.match(css, /\.object-training-checklist\s+li\[data-complete=["']true["']\]/);
  assert.match(functionSource("interactionItemName"), /category\s*===\s*["']distractor["'][\s\S]*["']混淆物["']/);
  assert.match(functionSource("interactionItemName"), /category\s*===\s*["']target["'][\s\S]*["']目标物["']/);
  assert.doesNotMatch(functionSource("makeSimRobotApi"), /packageVisual\s*===\s*["']ball["']\s*\?\s*["']红球["']/);
  assert.match(functionSource("initializeMissionAttempt"), /observedTrainingCategories:\s*new Set\(\)/);
  assert.match(functionSource("renderObjectTrainingPanel"), /observedTrainingCategories[\s\S]*observations\.forEach\(item\s*=>\s*observedCategories\.add\(item\.category\)\)/);
});

test("visual training examples enter a Guangyang training mode and do not contain a solved route", () => {
  const examples = [
    ["training-target", "target", ["observe", "approach", "grab", "holding"]],
    ["training-obstacle", "obstacle", ["observe"]],
    ["training-distractor", "distractor", ["observe", "approach", "grab", "holding", "road_state"]]
  ];
  const allowedMethods = new Set([
    "observe", "approach", "grab", "release", "holding", "road_state",
    "forward", "backward", "left", "right", "left_90", "right_90", "left_angle", "right_angle", "wait"
  ]);

  examples.forEach(([id, mode, requiredMethods]) => {
    assert.match(
      html,
      new RegExp(`data-example=["']${id}["']\\s+data-training-mode=["']${mode}["']`),
      `${id} must switch training focus without switching away from Guangyang`
    );
    const marker = `"${id}": \``;
    const start = app.indexOf(marker);
    assert.ok(start >= 0, `${id} source must exist`);
    const sourceStart = start + marker.length;
    const sourceEnd = app.indexOf("`", sourceStart);
    assert.ok(sourceEnd > sourceStart, `${id} source must be a template string`);
    const source = app.slice(sourceStart, sourceEnd);
    const methods = [...source.matchAll(/robot\.([a-z0-9_]+)/g)].map(match => match[1]);
    methods.forEach(method => assert.ok(allowedMethods.has(method), `${id} may not use robot.${method}()`));
    requiredMethods.forEach(method => assert.ok(methods.includes(method), `${id} should demonstrate robot.${method}()`));
    assert.doesNotMatch(source, /robot\.(?:forward|backward|left|right|left_90|right_90|left_angle|right_angle)\s*\(/,
      `${id} must not embed a solved Guangyang route`);
    assert.doesNotMatch(source, /(?:\[["'](?:id|x|z|position|coordinates?)["']\]|\.(?:id|x|z|position|coordinates?)\b)/i);
  });

  assert.match(functionSource("loadExample"), /trainingMode[\s\S]*enterGuangyangTrainingMode\(trainingMode\)/);
  assert.match(app, /training-distractor[\s\S]*robot\.road_state\(\)[\s\S]*leftClearanceCm[\s\S]*rightClearanceCm/,
    "distractor training should teach road-boundary sensing without a fixed cleanup marker");
  assert.match(app, /loadExample\(item\.dataset\.example,\s*item\.dataset\.scene,\s*item\.dataset\.trainingMode,\s*item\.dataset\.aiAutonomy\s*===\s*"true"\)/);
  ["objectTrainingCoach", "objectTrainingCoachMessage"].forEach(id => {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  });
  assert.match(functionSource("objectTrainingFeedback"), /target-delivery[\s\S]*distractor-removal[\s\S]*obstacle-avoidance/);
  assert.match(functionSource("renderObjectTrainingPanel"), /objectTrainingFeedback\([\s\S]*objectTrainingCoach\.dataset\.state/);
  const trainingZoneMarker = functionSource("addMarker");
  const competitionZoneMarker = functionSource("addObjectTaskZoneMarker");
  const zoneLabel = functionSource("addZoneLabel");
  assert.match(trainingZoneMarker, /visionZone[\s\S]*boundaryColor[\s\S]*vision-zone-sign/);
  assert.match(competitionZoneMarker, /guidanceColor[\s\S]*vision-zone-sign/);
  assert.match(competitionZoneMarker, /new THREE\.MeshBasicMaterial\(\{\s*color,\s*toneMapped:\s*false/,
    "the legacy upright sign retains the detector's saturated role color");
  assert.match(competitionZoneMarker, /new THREE\.PointLight\(\s*["']#ffffff["']\s*,\s*0\.2/,
    "zone guidance lights must not tint the ground into a detector-colored component");
  assert.match(competitionZoneMarker, /visibleStorageGround = robotBackendMode && role === "storage"/);
  assert.match(competitionZoneMarker, /fill\.userData\.hideFromVirtualCamera\s*=\s*!visibleStorageGround[\s\S]*ring\.userData\.hideFromVirtualCamera\s*=\s*true[\s\S]*beacon\.userData\.hideFromVirtualCamera\s*=\s*true[\s\S]*glow\.userData\.hideFromVirtualCamera\s*=\s*true/,
    "legacy camera excludes ground guidance; backend adds only the static storage ground and keeps animated helpers hidden");
  assert.match(trainingZoneMarker, /if\s*\(visionZone\)\s*mesh\.userData\.hideFromVirtualCamera\s*=\s*true[\s\S]*pulseRing\.userData\.hideFromVirtualCamera\s*=\s*true[\s\S]*boundaryRing\.userData\.hideFromVirtualCamera\s*=\s*true[\s\S]*beacon\.userData\.hideFromVirtualCamera\s*=\s*true[\s\S]*glow\.userData\.hideFromVirtualCamera\s*=\s*true/,
    "training camera evidence must exclude the pulsing pad, rings, beacon and light");
  assert.match(zoneLabel, /zoneDecal\.userData\.hideFromVirtualCamera\s*=\s*true/,
    "category-coloured floor labels must remain visible to users but stay out of camera evidence");
  assert.match(css, /\.object-training-coach\[data-state=["']retry["']\]/);
  assert.match(css, /\.object-training-coach\[data-state=["']success["']\]/);
});

test("Guangyang challenge scale grows from one to three object sets without reducing the shared time budget", () => {
  const config = core.GUANGYANG_ISLAND_CONFIG;
  const overlay = config.objectTaskOverlay;
  assert.equal(config.displayName, "广阳岛综合任务1");
  assert.deepEqual(
    core.GUANGYANG_CHALLENGE_CONFIGS.map(item => [item.taskId, item.displayName, item.timeLimitSeconds]),
    [
      ["R2-GYI-MVP-01", "广阳岛综合任务1", 600],
      ["R2-GYI-MVP-02", "广阳岛综合任务2", 600],
      ["R2-GYI-MVP-03", "广阳岛综合任务3", 600]
    ]
  );
  assert.deepEqual(core.GUANGYANG_CHALLENGE_CONFIGS.map(item => ({
    checkpoints: item.checkpoints.length,
    targets: item.objectTaskOverlay.objects.filter(object => object.role === "target").length,
    distractors: item.objectTaskOverlay.objects.filter(object => object.role === "distractor").length,
    obstacles: item.objectTaskOverlay.objects.filter(object => object.role === "obstacle").length
  })), [
    { checkpoints: 4, targets: 1, distractors: 1, obstacles: 1 },
    { checkpoints: 6, targets: 2, distractors: 2, obstacles: 2 },
    { checkpoints: 8, targets: 3, distractors: 3, obstacles: 3 }
  ]);
  assert.equal(config.task.type, "composite");
  assert.equal(config.task.schemaVersion, "chenlong.task/v5");
  assert.deepEqual(config.task.avoidanceObjectIds, ["guangyang-obstacle-1"]);
  assert.deepEqual(overlay.objects.map(item => [item.id, item.role, item.sourcePosition, item.radius]), [
    ["guangyang-target-1", "target", [354, 195], 0.28],
    ["guangyang-distractor-1", "distractor", [412, 590], 0.28],
    ["guangyang-obstacle-1", "obstacle", [319, 480], 0.52]
  ]);
  assert.deepEqual(overlay.zones.map(item => [item.id, item.role, item.sourcePosition]), [
    ["guangyang-storage-zone", "storage", [326, 151]]
  ]);
  assert.deepEqual(config.task.deliveries.map(item => [item.id, item.objectRole, item.destinationRole, item.requiredPackageIds]), [
    ["delivery-target-storage", "target", "storage", ["guangyang-target-1"]],
    ["delivery-distractor-offroad-removal", "distractor", "offroad-removal", ["guangyang-distractor-1"]]
  ]);
  const removal = config.task.deliveries.find(item => item.objectRole === "distractor");
  assert.equal(removal.placementRule, "road-edge-clearance");
  assert.equal(removal.minimumRoadEdgeClearance, 0.2);
  assert.equal(Object.prototype.hasOwnProperty.call(removal, "destination"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(removal, "radius"), false);
  assert.ok(Array.isArray(config.task.placementGeometry?.roads));

  assert.match(app, /GUANGYANG_OBJECT_TASK_FALLBACK[\s\S]*\[354,\s*195\][\s\S]*\[412,\s*590\][\s\S]*\[319,\s*480\]/);
  assert.match(functionSource("normalizeGuangyangObjectTaskOverlay"), /config\?\.objectTaskOverlay/);
  assert.match(functionSource("buildGuangyangCompositeTask"), /chenlong\.task\/v2[\s\S]*chenlong\.task\/v3[\s\S]*chenlong\.task\/v4[\s\S]*chenlong\.task\/v5/);
  assert.match(functionSource("buildGuangyangCompositeTask"), /road-edge-clearance[\s\S]*minimumRoadEdgeClearance[\s\S]*placementGeometry/);
  assert.match(functionSource("buildGuangyangCompositeTask"), /task\.avoidanceObjectIds[\s\S]*role\s*===\s*["']obstacle["']/);
  assert.match(functionSource("buildGuangyangCompositeTask"), /delete task\.avoidanceObjectIds/,
    "explicit task/v2 configurations must remain free of avoidance fields");
  assert.match(app, /title:\s*["']广阳岛综合任务["']/);
  assert.match(app, /objectObstacles:\s*GUANGYANG_OBJECT_TASK\.objects/);
  assert.match(app, /objectZones:\s*GUANGYANG_OBJECT_TASK\.zones/);
  assert.match(functionSource("rebuildSceneObjects"), /activeMission\.objectObstacles[\s\S]*createObstacleModel/);
  assert.match(functionSource("rebuildSceneObjects"), /activeMission\.objectZones[\s\S]*addObjectTaskZoneMarker/);
  assert.match(functionSource("createMissionTaskEngine"), /spec\.type\s*===\s*["']composite["'][\s\S]*definition\.deliveries[\s\S]*definition\.avoidanceObjectIds/);
  assert.match(functionSource("applyMissionTaskState"), /state\.avoidanceProgress/);
  assert.match(functionSource("missionProgressSnapshot"), /deliveryTotal[\s\S]*checkpointTotal[\s\S]*returnCompleted[\s\S]*avoidanceTotal/);
  assert.match(functionSource("missionProgressSnapshot"), /障碍绕行失败[\s\S]*请重置后重新比赛/);
  ["missionCompositeProgress", "missionDeliveryProgress", "missionAvoidanceProgress", "missionCheckpointProgress", "missionReturnProgress"]
    .forEach(id => assert.match(html, new RegExp(`id=["']${id}["']`)));
  assert.match(css, /\.competition-objective-strip\s*\{[\s\S]*repeat\(4,/);
  assert.match(css, /\.competition-objective-strip\s*>\s*div\[data-failed=["']true["']\]/);
});

test("object-task perception uses fixed object-and-zone capture and category-safe student results", () => {
  const capture = functionSource("captureVirtualCameraFrame");
  const exactMatcher = functionSource("getExactCategoryVisionObjects");
  const sharedProjection = functionSource("projectSimpleVisionQuery");
  const safeObservation = functionSource("safeVisionObservation");
  const requestHandler = functionSource("handleRealtimeRobotRequest");

  assert.match(app, /VIRTUAL_PIXEL_CLASSES\s*=\s*Object\.freeze\(\[["']target["'],\s*["']obstacle["'],\s*["']distractor["'],\s*["']storage-zone["'],\s*["']cleanup-zone["']\]\)/);
  ["目标物", "障碍物", "混淆物", "存放点", "清理点"]
    .forEach(category => assert.match(app, new RegExp(`["']${category}["']`)));
  assert.match(capture, /virtualPixelClasses:\s*\[\.\.\.VIRTUAL_PIXEL_CLASSES\]/);
  assert.doesNotMatch(capture, /packageVisual[\s\S]*virtualPixelClasses|obstacles\.length[\s\S]*virtualPixelClasses/);
  assert.match(exactMatcher, /requireTrainingVisionCategory\(category\)/);
  assert.match(exactMatcher, /canonicalVisionCategory\(object\)\s*===\s*exactCategory/);
  assert.match(requestHandler, /["']observe["'][\s\S]*\.includes\(method\)/);
  assert.match(requestHandler, /method\s*===\s*["']holding["']/);
  assert.match(requestHandler, /projectSimpleVisionQuery\(method,\s*args\)/);
  assert.match(sharedProjection, /ensureRealtimeVisionFrame\(\)/);
  assert.match(sharedProjection, /CarVisionPixelCore\?\.projectQuery/);
  assert.match(sharedProjection, /getDetections\.call\(window\.CarVision\)/);
  assert.match(sharedProjection, /查询核心未加载/);
  assert.match(requestHandler, /heldObjectCategory\(\)/);
  assert.doesNotMatch(safeObservation, /\b(?:x|z|box|position|coordinates?)\s*:/i);
  ["category", "categoryLabel", "name", "direction", "distanceCm", "confidence", "near", "stable"]
    .forEach(field => assert.match(safeObservation, new RegExp(`\\b${field}\\s*:`)));
  assert.match(requestHandler, /trainingVisionCategoryLabel\(category\)/);
});

test("automatic visual approach uses bounded angle corrections instead of coarse timed turns", () => {
  const angleHelper = functionSource("approachTurnDegrees");
  const approach = functionSource("approachVisionTarget");

  assert.match(angleHelper, /visionHorizontalOffset\(object\)/);
  assert.match(angleHelper, /Math\.max\(2,\s*Math\.min\(6,/);
  assert.match(approach, /const action\s*=\s*steeringAction\s*===\s*["']forward["']\s*\?\s*["']forward["']\s*:\s*`\$\{steeringAction\}_angle`/);
  assert.match(approach, /executeRealtimeAction\(action,\s*\[turnDegrees\s*\?\?\s*seconds\]/);
});

test("obstacle training requires a collision-free finish and interaction v2 carries object roles", () => {
  const initializer = functionSource("initializeMissionAttempt");
  const mover = functionSource("moveRobot");
  const evaluator = functionSource("evaluateMissionProgress");
  const progress = functionSource("missionProgressSnapshot");
  const interaction = functionSource("packageInteractionDefinition");

  assert.match(initializer, /trainingCollisionCount:\s*0/);
  assert.match(mover, /objectTraining\?\.type\s*===\s*["']obstacle-avoidance["']/);
  assert.match(mover, /trainingCollisionCount\s*=\s*Number\([\s\S]{0,100}\)\s*\+\s*1/);
  assert.match(evaluator, /result\.state\.finished\)\s*&&\s*!collisionInvalid/);
  assert.match(evaluator, /绕障训练需重试/);
  assert.match(progress, /请重置后重新绕行/);
  assert.match(interaction, /schemaVersion:\s*["']chenlong\.package-interaction\/v2["']/);
  assert.match(interaction, /packages:\s*packages\.map/);
  assert.match(interaction, /role:[\s\S]*["']distractor["'][\s\S]*["']obstacle["'][\s\S]*["']target["']/);
});

test("virtual camera resources have an explicit disposal lifecycle", () => {
  const disposer = functionSource("disposeVirtualCamera");
  const pagehideStart = app.indexOf('window.addEventListener("pagehide"');
  const pagehideEnd = app.indexOf('document.addEventListener("visibilitychange"', pagehideStart);
  const pagehideHandler = pagehideStart >= 0 && pagehideEnd > pagehideStart
    ? app.slice(pagehideStart, pagehideEnd)
    : "";

  assert.match(disposer, /virtualCameraTarget\?*\.dispose\(\)/);
  assert.match(disposer, /virtualCamera(?:\?*\.removeFromParent\(\)|[\s\S]*remove\(virtualCamera\))/);
  assert.match(disposer, /virtualCameraTarget\s*=\s*null/);
  assert.match(pagehideHandler, /if \(!event\.persisted\) \{[\s\S]*disposeVirtualCamera\(\)/,
    "confirmed page teardown must dispose resources while bfcache preserves them");
});

test("scene disposal deduplicates geometry, material, and texture shared by terrain layers", () => {
  const disposer = functionSource("disposeSceneObject");
  const rebuild = functionSource("rebuildSceneObjects");

  assert.match(disposer, /resources\s*\|\|\s*\{\s*geometries:\s*new Set\(\),\s*materials:\s*new Set\(\),\s*textures:\s*new Set\(\)\s*\}/);
  ["geometries", "materials", "textures"].forEach(resource => {
    assert.match(disposer, new RegExp(`disposed\\.${resource}\\.has\\(`));
    assert.match(disposer, new RegExp(`disposed\\.${resource}\\.add\\(`));
  });
  assert.match(rebuild, /const staleObjects\s*=\s*new Set\(/);
  assert.match(rebuild, /const disposedResources\s*=\s*\{\s*geometries:\s*new Set\(\),\s*materials:\s*new Set\(\),\s*textures:\s*new Set\(\)\s*\}/);
  assert.match(rebuild, /staleObjects\.forEach\(object\s*=>\s*disposeSceneObject\(object,\s*disposedResources\)\)/);
});

test("competition telemetry records the camera frame that informed robot vision", () => {
  const tick = functionSource("competitionTick");

  assert.match(tick, /cameraFrameId\s*:/);
  assert.match(tick, /(?:CarVision|virtualCamera)[\s\S]*frameId/);
  assert.match(tick, /virtualVision\?\.source\s*===\s*["']virtual["']/);
  assert.match(tick, /virtualVision\.frameId\s*===\s*latestVirtualCameraFrameId/);
});

test("virtual camera captures are invalidated across scene generations without promise cleanup races", () => {
  const starter = functionSource("startVirtualCameraVision");
  const invalidator = functionSource("invalidateVirtualCameraFrame");
  const rebuild = functionSource("rebuildSceneObjects");

  assert.match(starter, /const pendingCapture\s*=\s*captureVirtualCameraFrame\(\)/);
  assert.match(starter, /virtualCameraCapturePromise\s*===\s*pendingCapture/);
  assert.match(invalidator, /virtualCameraGeneration\s*\+=\s*1/);
  assert.match(invalidator, /latestVirtualCameraFrameId\s*=\s*null/);
  assert.match(invalidator, /CarVision\?\.stop\?\.\(\)/,
    "mission changes must clear detections captured from the previous scene");
  assert.match(rebuild, /invalidateVirtualCameraFrame\(\)/);
});

test("simulation robot vision no longer reads scene-object coordinates", () => {
  const visionRequestPath = [
    functionSource("getVisionSnapshot"),
    functionSource("readVisionObjects"),
    functionSource("getMatchingVisionObjects"),
    functionSource("handleRealtimeRobotRequest"),
    functionSource("approachVisionTarget")
  ].join("\n");

  assert.doesNotMatch(visionRequestPath, /visibleSimulationTarget\s*\(/);
  assert.doesNotMatch(visionRequestPath, /(?:mesh|object)\.position\.(?:x|z)/);
  assert.doesNotMatch(visionRequestPath, /(?:packageMeshes|obstacleMeshes|getTopPackageMeshes|robotPose)/);
  assert.match(functionSource("getVisionSnapshot"), /CarVision(?:\?\.|\.)getDetections(?:\?\.)?\(\)/);
});

test("the vision pipeline accepts canvas frames through analyzeFrame", () => {
  const dimensions = functionSource("sourceDimensions", vision);

  assert.match(dimensions, /naturalWidth[\s\S]*videoWidth[\s\S]*\.width/);
  assert.match(dimensions, /naturalHeight[\s\S]*videoHeight[\s\S]*\.height/);
  assert.ok(
    /window\.CarVision\s*=\s*\{[\s\S]*analyzeFrame(?:\s*\(|\s*[,}])/.test(vision),
    "CarVision must expose analyzeFrame"
  );
  assert.ok(/analyzeFrame\s*\([\s\S]*frameId/.test(vision), "analyzed pixel frames must produce a frame id");
});

test("simulation motion and waits are driven by the fixed-step core", () => {
  const definition = functionSource("simulationDefinition");
  const world = functionSource("simulationWorldDefinition");
  const runner = functionSource("runDeterministicCommand");
  const mover = functionSource("moveRobot");
  const turner = functionSource("turnRobot");
  const angleTurner = functionSource("turnRobotAngle");
  const robotApi = functionSource("makeSimRobotApi");
  const tick = functionSource("competitionTick");

  assert.match(definition, /stepMs:\s*20/);
  assert.match(definition, /seed:\s*Number\(activeMission\?\.competition\?\.randomSeed/);
  assert.match(definition, /initialPose:\s*\{\s*x:\s*robotPose\.x,\s*z:\s*robotPose\.z,\s*heading:\s*robotPose\.heading\s*\}/);
  assert.match(world, /minX:\s*-currentMapWidth\(\)\s*\/\s*2/);
  assert.match(world, /maxX:\s*currentMapWidth\(\)\s*\/\s*2/);
  assert.match(world, /minZ:\s*-currentMapDepth\(\)\s*\/\s*2/);
  assert.match(world, /maxZ:\s*currentMapDepth\(\)\s*\/\s*2/);

  assert.match(runner, /simulatorCore\.startCommand\(command\)/);
  assert.match(runner, /competitionSession\.addSimulationInput\(started\.command/);
  assert.match(runner, /simulatorCore\.step\(\)/);
  assert.match(runner, /robotPose\.x\s*=\s*state\.pose\.x/);
  assert.match(runner, /robotPose\.z\s*=\s*state\.pose\.z/);
  assert.match(runner, /robotPose\.heading\s*=\s*state\.pose\.heading/);
  assert.match(runner, /else await sleep\(0\)/, "a lagging fixed-step loop must yield to browser controls");

  assert.match(mover, /runDeterministicCommand\(\{[\s\S]*kind:\s*["']drive["']/);
  assert.match(turner, /runDeterministicCommand\(\{[\s\S]*kind:\s*["']turn["']/);
  assert.match(angleTurner, /runDeterministicCommand\(\{[\s\S]*kind:\s*["']turn_angle["']/);
  assert.match(robotApi, /wait:\s*async\s+seconds\s*=>\s*\{[\s\S]*runDeterministicCommand\(\{[\s\S]*kind:\s*["']wait["']/);
  [mover, turner, angleTurner].forEach(source => {
    assert.doesNotMatch(source, /performance\.now\(\)/, "vehicle physics must not integrate browser wall-clock deltas");
  });
  assert.match(tick, /tick:\s*deterministicSimulator\?\.tick/);
});

test("collision penalties are recorded before a blocked frame can complete the task", () => {
  const runner = functionSource("runDeterministicCommand");
  const mover = functionSource("moveRobot");
  const violationRecorder = functionSource("recordCompetitionViolation");

  assert.match(runner, /onFrame\(lastFrame\)/);
  assert.match(runner, /syncRobot\(undefined/);
  assert.ok(
    runner.indexOf("onFrame(lastFrame)") < runner.indexOf("syncRobot(undefined"),
    "the frame callback must run before competition telemetry can complete and seal the task"
  );
  assert.match(mover, /frame\.blocked\s*&&\s*!collisionObserved/);
  assert.match(mover, /recordCompetitionViolation\([\s\S]*?["']collision["'][\s\S]*?frame\.elapsedMs\s*\)/);
  assert.match(violationRecorder, /competitionSession\.recordViolation\(type, detail, Number\(elapsedMsOverride\)\)/);
});

test("competition records expose deterministic replay from the HUD", () => {
  const starter = functionSource("startCompetitionRun");
  const replay = functionSource("replayLatestCompetitionRecord");
  const localEvaluator = functionSource("evaluateMissionProgress");
  const missionLoader = functionSource("loadMission");
  const customMapLoader = functionSource("applyMapPayload");

  assert.match(html, /id="replayRunRecordButton"/);
  assert.match(starter, /simulationDefinition:\s*simulatorCore\.definition\(\)/);
  assert.match(app, /replayRunRecordButton\?\.addEventListener\(["']click["'],\s*replayLatestCompetitionRecord\)/);
  assert.match(replay, /new Player\(latestCompetitionRecord\)/);
  assert.match(replay, /player\.trajectory\(\)/);
  assert.match(replay, /setReplayButtonState\(true\)[\s\S]*正在重建确定性轨迹/);
  assert.match(replay, /await new Promise\(resolve\s*=>\s*setTimeout\(resolve,\s*0\)\)/,
    "long deterministic reconstruction must paint visible preparation feedback first");
  assert.match(replay, /player\.verify\(\)/);
  assert.match(replay, /player\.mode\s*===\s*["']deterministic["']/);
  assert.match(replay, /syncRobot\(undefined, \{ forceTelemetry: true \}\)/);
  assert.match(replay, /player\.mode\s*===\s*["']telemetry["'][\s\S]*遥测回放完成（非确定性）/);
  assert.match(replay, /latestCompetitionRecord\.mapId[\s\S]*!currentCompetition/,
    "a map-bound record must not replay in a non-competition scene");
  assert.ok(
    missionLoader.indexOf("stopCompetitionReplay()") >= 0
      && missionLoader.indexOf("stopCompetitionReplay()") < missionLoader.indexOf("activeMission ="),
    "changing a built-in mission must stop replay before replacing the scene"
  );
  assert.ok(
    customMapLoader.indexOf("stopCompetitionReplay()") >= 0
      && customMapLoader.indexOf("stopCompetitionReplay()") < customMapLoader.indexOf("activeMission ="),
    "loading a custom map must stop replay before replacing the scene"
  );
  assert.match(app, /sceneSelect["']\)\.addEventListener\(["']change["'],\s*event\s*=>\s*\{[\s\S]*loadMission\(event\.target\.value\)/,
    "the task selector must stay routed through the replay-safe mission loader");
  assert.match(localEvaluator, /isCompetitionMission\(\)\s*&&\s*competitionSession\s*&&\s*!replayRunning/);
  assert.match(localEvaluator, /if \(replayRunning\)\s*\{[\s\S]*missionAttempt\.completed\s*=\s*true/);
});

test("the competition HUD submits records to the bounded non-authoritative backend", () => {
  const probe = functionSource("probeVerificationService");
  const verifier = functionSource("verifyLatestCompetitionRecordOnServer");
  const reset = functionSource("resetCompetitionVerificationResult");

  assert.match(html, /id="competitionVerifierHealth"/);
  assert.match(html, /id="competitionVerifierResult"/);
  assert.match(html, /id="competitionRecordActionStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /id="verifyRunRecordButton"/);
  assert.match(probe, /\/api\/health|VERIFICATION_HEALTH_ENDPOINT/);
  assert.match(probe, /chenlong\.backend-health\/v1/);
  assert.match(probe, /authoritative\s*!==\s*false/);
  assert.match(verifier, /\/api\/v1\/verify-run-record|RUN_RECORD_VERIFICATION_ENDPOINT/);
  assert.match(verifier, /prepareCompetitionRecordUpload\(record\)/);
  assert.match(verifier, /body:\s*upload\.body/);
  assert.match(verifier, /"Content-Encoding":\s*upload\.contentEncoding/);
  assert.match(verifier, /chenlong\.verification-report\/v1/);
  assert.match(verifier, /report\.authoritative\s*!==\s*false/);
  assert.match(reset, /serverVerificationAbortController\?\.abort\(\)/);
  assert.match(app, /verifyRunRecordButton\?\.addEventListener\(["']click["'],\s*verifyLatestCompetitionRecordOnServer\)/);
});

test("a server-issued session is created before a competition recorder is started", () => {
  const creator = functionSource("createCompetitionServerSession");
  const normalizer = functionSource("normalizeServerSession");
  const starter = functionSource("startCompetitionRun");
  const runner = functionSource("runProgram");

  assert.match(creator, /COMPETITION_SESSION_ENDPOINT/);
  assert.match(creator, /method:\s*["']POST["']/);
  assert.match(creator, /body:\s*JSON\.stringify\(\{[\s\S]*taskId,[\s\S]*mode:\s*aiAutonomyMode\s*\?\s*AI_AUTONOMY_SESSION_MODE\s*:\s*["']standard["']/);
  assert.match(creator, /await\s+globalThis\.chenlongAuthReady/);
  assert.match(creator, /normalizeServerSession\(payload,\s*guangyangConfigForTaskId\(taskId\),\s*aiAutonomyMode\)/,
    "published maps must still validate their server binding against the immutable base challenge version");
  assert.doesNotMatch(creator, /normalizeServerSession\(payload,\s*config,\s*aiAutonomyMode\)/,
    "a published map version must not be used as the base version for a second binding suffix");
  assert.match(creator, /requestSerial\s*!==\s*competitionSessionRequestSerial/);
  assert.match(creator, /activeCompetitionServerSession\s*=\s*session/);
  assert.match(creator, /competitionSessionExpiryTimeoutId\s*=\s*setTimeout/);
  assert.match(creator, /setTimeout\([\s\S]*updateCompetitionSubmissionButton\(\)/);
  assert.match(normalizer, /schemaVersion\s*!==\s*SESSION_SCHEMA_VERSION/);
  assert.match(normalizer, /authoritative\s*!==\s*false/);
  assert.match(normalizer, /\^tea_\[a-f0-9\]\{32\}\$/,
    "single sessions must carry a stable internal team id rather than a user id");
  assert.match(normalizer, /session\.challenge\?\.taskId\s*!==\s*expectedConfig\?\.taskId/);
  assert.match(normalizer, /session\.challenge\?\.taskVersion\s*!==\s*expectedConfig\?\.taskVersion/);
  assert.match(normalizer, /session\.challenge\?\.mapId\s*!==\s*expectedConfig\?\.mapId/);
  assert.match(normalizer, /session\.challenge\?\.mapVersion\s*!==\s*mapConfig\.mapVersion/);
  assert.match(normalizer, /objectAnchorDisclosure\s*===\s*["']none["']/);
  assert.match(normalizer, /aiAutonomyMode\s*!==\s*expectedAiAutonomyMode/);
  assert.match(normalizer, /runDefinition:\s*structuredClone\(runDefinition\)/);
  assert.match(normalizer, /mapConfig,/);
  assert.match(normalizer, /session\.challenge\?\.ruleVersion\s*!==\s*expectedConfig\?\.ruleVersion/);
  assert.match(normalizer, /Date\.parse\(session\.expiresAt\)/, "expired or malformed server sessions must not be bound");

  const requestIndex = starter.indexOf("await createCompetitionServerSession(config");
  const recorderIndex = starter.indexOf("CompetitionCore.createSession(config");
  assert.ok(requestIndex >= 0 && recorderIndex > requestIndex, "the recorder must use the server-issued run id");
  assert.match(starter, /competitionSession\s*=\s*null[\s\S]*await createCompetitionServerSession/, "old recorders must not survive the async session-creation window");
  assert.match(starter, /expectedRunToken\s*!==\s*runToken[\s\S]*clearSession:\s*true/);
  assert.match(starter, /runId:\s*serverSession\.runId/);
  assert.match(starter, /serverSessionId:\s*serverSession\.sessionId/);
  assert.match(starter, /challengeDigest:\s*serverSession\.challengeDigest/);
  assert.match(starter, /runDefinition:\s*serverSession\.runDefinition/);
  assert.match(starter, /jsonStructuresEqual\(createdRunDefinition,\s*serverSession\.runDefinition\)/);
  assert.match(runner, /await startCompetitionRun\(source,\s*currentRunToken\)/);
});

test("the server challenge and browser recorder use the same interaction definition generation", () => {
  const challenge = Object.values(serverModule.LOCAL_CHALLENGES)[0];
  assert.equal(challenge.runDefinition.interactionDefinition.schemaVersion, "chenlong.package-interaction/v2");
  assert.deepEqual(challenge.runDefinition.interactionDefinition.packages.map(item => ({
    id: item.id,
    role: item.role,
    radius: item.radius
  })), [
    { id: "guangyang-target-1", role: "target", radius: 0.28 },
    { id: "guangyang-distractor-1", role: "distractor", radius: 0.28 },
    { id: "guangyang-obstacle-1", role: "obstacle", radius: 0.52 }
  ]);
  assert.match(functionSource("packageInteractionDefinition"), /schemaVersion:\s*["']chenlong\.package-interaction\/v2["']/);
  assert.match(functionSource("packageInteractionDefinition"), /role:\s*["']obstacle["'][\s\S]*radius:/);
  const worldDefinition = functionSource("simulationWorldDefinition");
  const colliders = functionSource("rebuildRobotCollisionShapes");
  assert.match(worldDefinition, /robotCollisionShapes\.filter\(shape\s*=>\s*shape\.source\s*!==\s*["']package["']\)/);
  assert.match(colliders, /interactionObjectId\s*\?\s*`object:\$\{interactionObjectId\}`/);
  assert.match(colliders, /source:\s*interactionObjectId\s*\?\s*["']package["']\s*:\s*["']obstacle["']/);
  assert.match(colliders, /mesh\.userData\.collisionRadius/);
});

test("finished single runs auto-save without blocking the next run and submit only by record action", () => {
  const matcher = functionSource("recordMatchesCompetitionServerSession");
  const upload = functionSource("prepareCompetitionRecordUpload");
  const saver = functionSource("saveCompetitionRecordDraft");
  const committer = functionSource("commitCompetitionRecord");
  const runner = functionSource("runProgram");
  const submitSaved = functionSource("submitSavedCompetitionRecord");

  assert.match(html, /id="competitionSubmissionResult"/);
  assert.match(matcher, /record\.schemaVersion\s*===\s*["']chenlong\.run-record\/v4["']/);
  assert.match(matcher, /record\.serverSessionId\s*===\s*session\.sessionId/);
  assert.match(matcher, /record\.runId\s*===\s*session\.runId/);
  assert.match(matcher, /record\.challengeDigest\s*===\s*session\.challengeDigest/);
  assert.match(matcher, /Date\.parse\(session\.expiresAt\)/);
  assert.match(upload, /CompressionStream\(["']gzip["']\)/);
  assert.match(upload, /rawByteLength/);
  assert.match(upload, /wireByteLength/);
  assert.match(saver, /\/drafts/);
  assert.match(saver, /prepareCompetitionRecordUpload\(record\)/);
  assert.match(saver, /["']Content-Encoding["']/);
  assert.match(saver, /response\.status\s*===\s*413/);
  assert.match(saver, /validateCompetitionDraftReceipt/);
  assert.match(saver, /不影响继续运行|下一次运行不会被阻止/);
  assert.match(committer, /saveCompetitionRecordDraft\(record,\s*draftSession\)/);
  assert.doesNotMatch(runner, /上一场记录尚未存档|competitionRecordAlreadyArchived/);
  assert.match(submitSaved, /\/submit/);
  assert.match(submitSaved, /method:\s*["']POST["']/);
  assert.match(submitSaved, /body:\s*["']\{\}["']/);
});

test("submission receipts are strictly matched without exposing the bearer token", () => {
  const submitter = functionSource("submitLatestCompetitionRecord");
  const performer = functionSource("performLatestCompetitionRecordSubmission");

  assert.match(submitter, /competitionSubmissionOperation/);
  assert.match(submitter, /performLatestCompetitionRecordSubmission\(operation\.record,\s*operation\.session\)/);
  assert.match(performer, /!recordMatchesActiveServerSession\(record\)/);
  assert.match(performer, /explainMissingCompetitionRecord\(["']提交["']\)/);
  assert.match(performer, /运行记录与当前服务端场次不匹配/);
  assert.match(performer, /\/api\/v1\/sessions\/\$\{encodeURIComponent\(session\.sessionId\)\}\/submissions/);
  assert.match(performer, /Authorization:\s*`Bearer \$\{session\.submitToken\}`/);
  assert.match(performer, /prepareCompetitionRecordUpload\(record\)/);
  assert.match(performer, /body:\s*upload\.body/);
  assert.match(performer, /requestSerial\s*!==\s*competitionSubmissionRequestSerial/);
  assert.match(performer, /record\s*!==\s*latestCompetitionRecord/);
  assert.match(performer, /session\s*!==\s*activeCompetitionServerSession/);
  assert.match(performer, /receipt\.schemaVersion\s*!==\s*SUBMISSION_RECEIPT_SCHEMA_VERSION/);
  assert.match(performer, /receipt\.authoritative\s*!==\s*false/);
  assert.match(performer, /receipt\.sessionId\s*!==\s*session\.sessionId/);
  assert.match(performer, /receipt\.challengeDigest\s*!==\s*session\.challengeDigest/);
  assert.match(performer, /typeof receipt\.duplicate\s*!==\s*["']boolean["']/);
  assert.match(performer, /report\.schemaVersion\s*!==\s*["']chenlong\.verification-report\/v1["']/);
  assert.match(performer, /report\.authoritative\s*!==\s*false/);
  assert.match(performer, /latestCompetitionSubmissionReceipt\s*=\s*\{\s*\.\.\.receipt,\s*recordRef:\s*record\s*\}/);
  assert.doesNotMatch(performer, /(?:addLog|setCompetitionSubmissionResult)\([^\n]*submitToken/);
  assert.doesNotMatch(app, /console\.[A-Za-z]+\([^\n]*submitToken/);
  assert.doesNotMatch(app, /sessionStorage[\s\S]{0,240}submitToken|submitToken[\s\S]{0,240}sessionStorage/);
  assert.match(app, /submitRunRecordButton\?\.addEventListener\(["']click["'],\s*submitLatestCompetitionRecord\)/);
});

test("My Records is an in-workspace dialog with an explicit pending-record submit action", () => {
  const navigator = functionSource("openCompetitionRecords");
  const pendingRenderer = functionSource("renderPendingCompetitionRecord");
  const pendingSubmitter = functionSource("submitPendingCompetitionRecord");
  const unloadStart = app.indexOf('window.addEventListener("beforeunload"');
  const unloadSection = app.slice(unloadStart, app.indexOf('window.addEventListener("pagehide"', unloadStart));
  const trigger = html.match(/<button\b[^>]*id="recordsNavLink"[^>]*>/)?.[0] || "";
  const dialog = html.match(/<dialog\b[^>]*id="competitionRecordsDialog"[^>]*>/)?.[0] || "";

  assert.ok(trigger, "My Records must be a button so it cannot navigate away from the editor");
  assert.match(trigger, /type="button"/);
  assert.match(trigger, /aria-haspopup="dialog"/);
  assert.match(trigger, /aria-controls="competitionRecordsDialog"/);
  assert.match(trigger, /aria-expanded="false"/);
  assert.doesNotMatch(trigger, /\shref=/);
  assert.ok(dialog, "the simulator must own an in-page records dialog");
  assert.match(dialog, /aria-labelledby="competitionRecordsTitle"/);
  for (const id of [
    "competitionRecordsTitle",
    "closeCompetitionRecordsButton",
    "competitionRecordsStatus",
    "competitionRecordsList",
    "submitPendingRunRecordButton"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing in-workspace records element #${id}`);
  }
  assert.match(html, /id="pendingCompetitionRecord"[^>]*data-record-state="empty"/);
  const recordsShellRule = cssRule(".workspace-records-shell");
  const recordsContentRule = cssRule(".workspace-records-content");
  const recordsListRule = cssRule(".workspace-records-list");
  assert.match(recordsShellRule, /height:\s*100%/,
    "the records dialog must establish a bounded height for its scroll region");
  assert.match(recordsContentRule, /min-height:\s*0[\s\S]*flex:\s*1 1 auto[\s\S]*overflow:\s*hidden/,
    "the records body must allow the record list to shrink inside the dialog");
  assert.match(css, /\.workspace-records-archive\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1 1 auto[^}]*flex-direction:\s*column/,
    "the archive card must pass remaining height to its list");
  assert.match(recordsListRule, /min-height:\s*0[\s\S]*flex:\s*1 1 auto[\s\S]*overflow-y:\s*auto[\s\S]*overscroll-behavior:\s*contain/,
    "long run records must have their own vertical scroll area");
  assert.match(css, /\.workspace-records-submit\[hidden\]\s*\{[^}]*display\s*:\s*none/,
    "an empty current-run card must not expose a misleading submit button");
  assert.match(pendingRenderer, /state\s*=\s*["']pending["']/,
    "the current-run card must become [data-record-state=pending] after a bound run finishes");
  assert.match(pendingRenderer, /pendingCompetitionRecord\.dataset\.recordState\s*=\s*state/);
  assert.match(app, /recordsNavLink\?\.addEventListener\(["']click["'],\s*openCompetitionRecords\)/);
  assert.match(navigator, /event\?\.preventDefault\?\.\(\)/);
  assert.match(navigator, /competitionRecordsDialog\.showModal\(\)/);
  assert.doesNotMatch(navigator, /location\.(?:assign|replace)|recordsNavLink\.href/,
    "opening My Records must not unload the workbench");
  assert.doesNotMatch(navigator, /await\s+pendingOperation\.promise/,
    "opening My Records must not silently submit a pending record");
  assert.match(app, /closeCompetitionRecordsButton\?\.addEventListener\(["']click["']/);
  assert.match(app, /submitPendingRunRecordButton\?\.addEventListener\(["']click["'],\s*submitPendingCompetitionRecord\)/);
  assert.match(pendingSubmitter, /await\s+submitLatestCompetitionRecord\(\)/,
    "the dialog submit action must reuse the existing explicit submission path");
  assert.match(unloadSection, /event\.returnValue\s*=\s*["']{2}/);
  assert.doesNotMatch(unloadSection, /competitionSubmissionAbortController\?\.abort\(\)/);
});
