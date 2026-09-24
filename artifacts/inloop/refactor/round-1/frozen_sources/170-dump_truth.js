#!/usr/bin/env node
"use strict";
// 真值导出脚本（仅测试使用）。
// 从平台冻结配置导出三道赛题全部地图池布局、起点位姿、公开路网，
// 供 tests/acceptance/truth.py 使用。算法路径禁止读取本脚本产物。
const fs = require("node:fs");
const path = require("node:path");

const platformRoot = process.env.GUANGYANG_PLATFORM_ROOT
  || "/Users/ken/Desktop/robot_competition-main/projects/car-python";
const outRoot = process.env.WM_TRUTH_DIR
  || path.join(process.env.HOME || "", "wm_bench", "artifacts", "truth");

const core = require(path.join(platformRoot, "competition-core.js"));
const pool = require(path.join(platformRoot, "backend", "guangyang-map-pool.js"));

// 平台视觉管线里各类别的物理宽度（米），来自 vision-pixel-core.js 的类别定义
const PHYSICAL_WIDTH_M = { target: 0.44, distractor: 0.44, obstacle: 0.46, "storage-zone": 0.38 };

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

// 点到道路折线的最近点：返回 { roadId, progress(world units), distance(world units) }
function nearestRoadAnchor(point, roads) {
  let best = null;
  for (const road of roads) {
    let progress = 0;
    for (let i = 1; i < road.points.length; i += 1) {
      const a = road.points[i - 1], b = road.points[i];
      const abx = b[0] - a[0], abz = b[1] - a[1];
      const len2 = abx * abx + abz * abz;
      let t = len2 > 0 ? ((point[0] - a[0]) * abx + (point[1] - a[1]) * abz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a[0] + abx * t, pz = a[1] + abz * t;
      const d = Math.hypot(point[0] - px, point[1] - pz);
      if (!best || d < best.distance) {
        best = { roadId: road.id, progress: progress + Math.sqrt(len2) * t, distance: d, roadLength: polylineLength(road.points) };
      }
      progress += Math.sqrt(len2);
    }
  }
  return best;
}

function main() {
  fs.mkdirSync(outRoot, { recursive: true });
  const summary = [];
  for (const cfg of core.GUANGYANG_CHALLENGE_CONFIGS) {
    const layouts = pool.buildInitialMapPoolLayouts(cfg);
    const unitsPerMeter = cfg.rules.unitsPerMeter;
    const [sx, sz, heading] = cfg.start;
    const rules = { ...cfg.rules, roads: cfg.roads };
    const state = { tick: 0, pose: { x: sx, z: sz, heading }, initialPose: { x: sx, z: sz, heading }, distance: 0, rules };
    const graph = core.projectNavigationQuery("map_graph", state);
    const roadState = core.projectNavigationQuery("road_state", state);
    const taskDir = path.join(outRoot, cfg.taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "graph.json"), JSON.stringify({
      taskId: cfg.taskId, graph, startRoadState: roadState,
      roads: cfg.roads.map(r => ({ id: r.id, width: r.width, points: r.points, oneWay: r.oneWay || false }))
    }, null, 1));
    layouts.forEach((layout, index) => {
      const mapId = `map-${String(index + 1).padStart(2, "0")}`;
      const objects = [];
      const push = (cls, p) => {
        const anchor = nearestRoadAnchor(p, cfg.roads);
        objects.push({
          cls, world: p, physical_width_m: PHYSICAL_WIDTH_M[cls],
          anchor: { roadId: anchor.roadId, progressCm: anchor.progress * 100 / unitsPerMeter,
            roadLengthCm: anchor.roadLength * 100 / unitsPerMeter, offRoadDistanceCm: anchor.distance * 100 / unitsPerMeter }
        });
      };
      layout.targets.forEach(p => push("target", p));
      layout.distractors.forEach(p => push("distractor", p));
      layout.obstacles.forEach(p => push("obstacle", p));
      push("storage-zone", layout.storage);
      const record = {
        schema: "wm-acceptance-truth/v1",
        taskId: cfg.taskId, mapId,
        unitsPerMeter,
        start: { x: sx, z: sz, heading },
        // 平台车体约定：forward = (-sin h, -cos h)，right = (cos h, -sin h)；heading 增大 = 左转
        conventions: { forward: "(-sin h, -cos h)", right: "(cos h, -sin h)", headingPositive: "left/ccw", bearingPositive: "right" },
        checkpoints: layout.checkpoints,
        objects
      };
      fs.writeFileSync(path.join(taskDir, `${mapId}.json`), JSON.stringify(record, null, 1));
      summary.push({ taskId: cfg.taskId, mapId, objects: objects.length });
    });
  }
  fs.writeFileSync(path.join(outRoot, "index.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ outRoot, layouts: summary.length }));
}

main();
