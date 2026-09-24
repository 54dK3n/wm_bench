"use strict";

(function initPrimaryGuangyangMaps(root, factory) {
  const scoring = typeof module === "object" && module.exports
    ? require("./guangyang-scoring.js")
    : root?.PrimaryGuangyangScoring;
  const api = factory(scoring);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PrimaryGuangyangMaps = api;
})(typeof globalThis === "object" ? globalThis : this, scoring => {
  if (!scoring?.roadMatch) throw new Error("广阳岛道路规则没有加载");

  const MAP = Object.freeze({ width: 40, depth: 24, minimumX: -19, maximumX: 19, minimumZ: -11, maximumZ: 11 });
  const START = Object.freeze([-2.4865, -7.6757]);
  const TASKS = Object.freeze({
    "GYI-PRIMARY-01": Object.freeze({
      key: "guangyang1", level: 1, name: "广阳岛综合任务1", checkpoints: 4, objects: 1,
      checkpointLabels: Object.freeze(["戴胜湖路口", "白鹭湖", "油菜花田", "神兽营地"])
    }),
    "GYI-PRIMARY-02": Object.freeze({
      key: "guangyang2", level: 2, name: "广阳岛综合任务2", checkpoints: 6, objects: 2,
      checkpointLabels: Object.freeze(["戴胜湖路口", "白鹭湖", "油菜花田", "神兽营地", "中央北路口", "中央南路口"])
    }),
    "GYI-PRIMARY-03": Object.freeze({
      key: "guangyang3", level: 3, name: "广阳岛综合任务3", checkpoints: 8, objects: 3,
      checkpointLabels: Object.freeze(["戴胜湖路口", "白鹭湖", "油菜花田", "神兽营地", "中央北路口", "中央南路口", "西中路口", "东外环路口"])
    })
  });
  const DEFAULT_LAYOUTS = Object.freeze({
    "GYI-PRIMARY-01": freezeLayout({
      checkpoints: [[-2.4865, -2.4556], [7.1815, -3.2587], [6.471, 0.4479], [4.4324, 6.8726]],
      targets: [[-9.8687, -6.7181]], storage: [-10.7336, -8.0772],
      distractors: [[-8.0772, 5.4826]], obstacles: [[-10.9498, 2.0849]]
    }),
    "GYI-PRIMARY-02": freezeLayout({
      checkpoints: [[-2.4765, -2.4556], [7.1815, -3.2587], [6.471, 0.4479], [4.4324, 6.8726], [-2.4865, -5.4826], [-2.4865, 4.4324]],
      targets: [[-9.8387, -6.7181], [9.3127, -3.2587]], storage: [-10.7336, -8.0772],
      distractors: [[-8.0772, 5.4926], [-2.4865, -4.4015]], obstacles: [[-10.9498, 2.0849], [1.1274, -0.7568]]
    }),
    "GYI-PRIMARY-03": freezeLayout({
      checkpoints: [[-2.4765, -2.4556], [7.1815, -3.2587], [6.471, 0.4479], [4.4324, 6.8726], [-2.4865, -5.4826], [-2.4865, 4.4324], [-11.5985, -0.7568], [13.7297, 0.7568]],
      targets: [[-9.8787, -6.7181], [9.3127, -3.2587], [10.0849, 1.251]], storage: [-10.7336, -8.0772],
      distractors: [[-8.0772, 5.4926], [-2.4865, -4.4015], [6.7799, 4.6795]], obstacles: [[-10.9498, 2.0849], [1.1274, -0.7568], [-4.5869, 4.4324]]
    })
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function freezeLayout(layout) {
    Object.values(layout).forEach(value => {
      if (Array.isArray(value)) {
        value.forEach(item => { if (Array.isArray(item)) Object.freeze(item); });
        Object.freeze(value);
      }
    });
    return Object.freeze(layout);
  }

  function roundCoordinate(value) {
    return Math.round(Number(value) * 10000) / 10000;
  }

  function point(value, label) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) {
      throw new TypeError(`${label}坐标格式不正确`);
    }
    const normalized = [roundCoordinate(value[0]), roundCoordinate(value[1])];
    if (normalized[0] < MAP.minimumX || normalized[0] > MAP.maximumX
      || normalized[1] < MAP.minimumZ || normalized[1] > MAP.maximumZ) {
      throw new RangeError(`${label}必须位于地图范围内`);
    }
    if (!scoring.roadMatch(normalized[0], normalized[1]).onRoad) {
      throw new RangeError(`${label}必须放在可通行道路上`);
    }
    return normalized;
  }

  function pointList(value, expectedLength, label) {
    if (!Array.isArray(value) || value.length !== expectedLength) {
      throw new RangeError(`${label}数量必须是 ${expectedLength}`);
    }
    return value.map((item, index) => point(item, `${label} ${index + 1}`));
  }

  function assertSpacing(layout) {
    const entries = [
      ...layout.checkpoints.map((value, index) => [`途径点 ${index + 1}`, value]),
      ...layout.targets.map((value, index) => [`目标物 ${index + 1}`, value]),
      ["目标点", layout.storage],
      ...layout.distractors.map((value, index) => [`混淆物 ${index + 1}`, value]),
      ...layout.obstacles.map((value, index) => [`障碍物 ${index + 1}`, value])
    ];
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const distance = Math.hypot(entries[left][1][0] - entries[right][1][0], entries[left][1][1] - entries[right][1][1]);
        if (distance < 0.7) throw new RangeError(`${entries[left][0]}与${entries[right][0]}距离过近`);
      }
    }
    for (const [label, value] of entries) {
      if (Math.hypot(value[0] - START[0], value[1] - START[1]) < 0.9) {
        throw new RangeError(`${label}距离小车起点过近`);
      }
    }
  }

  function normalizeLayout(taskId, value) {
    const task = TASKS[taskId];
    if (!task) throw new RangeError("任务编号不存在");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("地图配置格式不正确");
    const keys = Object.keys(value).sort().join(",");
    const localKeys = "checkpoints,distractors,obstacles,storage,targets";
    const canonicalKeys = "checkpoints,distractors,obstacles,schemaVersion,storage,targets";
    if (keys !== localKeys
      && (keys !== canonicalKeys || value.schemaVersion !== "chenlong.guangyang-map-layout/v2")) {
      throw new TypeError("地图配置字段不正确");
    }
    const layout = {
      checkpoints: pointList(value.checkpoints, task.checkpoints, "途径点"),
      targets: pointList(value.targets, task.objects, "目标物"),
      storage: point(value.storage, "目标点"),
      distractors: pointList(value.distractors, task.objects, "混淆物"),
      obstacles: pointList(value.obstacles, task.objects, "障碍物")
    };
    assertSpacing(layout);
    return layout;
  }

  function defaultLayout(taskId) {
    if (!DEFAULT_LAYOUTS[taskId]) throw new RangeError("任务编号不存在");
    return clone(DEFAULT_LAYOUTS[taskId]);
  }

  return Object.freeze({ MAP, START, TASKS, DEFAULT_LAYOUTS, defaultLayout, normalizeLayout, clone });
});
