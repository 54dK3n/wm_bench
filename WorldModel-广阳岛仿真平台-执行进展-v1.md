# WorldModel × 广阳岛仿真平台 执行进展 v1

> 依据文档：`WorldModel-广阳岛仿真平台-集成方案-v1.md`
> 执行日期：2026-09-16
> 状态：P0 完成，P1 完成，P2 代码与单测完成（真实 10 套布局指标待补），P3 算法层完成（平台实测标定与端到端待补）

## 1. 当前结论

- P0 五项验收均已取得可复现证据。
- P1 平台改造已完成，数值方位角 `bearingDeg` 已进入 `robot.observe()` 返回。
- P2 provider 已新建并通过单测；真实 10 套布局的定位、裂轨、错并、时效性指标尚未跑批。
- P3 已完成最短转角、Dijkstra、代价选择、k 拟合算法层；P3.1 的平台实测 k、P3.4 端到端选择尚未执行。
- P4 规划闭环尚未开始。

## 2. P0 环境打通与基线固化

| 验收项 | 结果 | 证据 |
|---|---|---|
| 0.1 平台自检 | 通过 | 根仓库 101 用例，100 通过，0 失败，1 跳过；`projects/car-python` 607 用例，603 通过，0 失败，4 跳过 |
| 0.2 WorldModel 自检 | 通过 | `~/wm_kit` 当前 160 通过，0 失败 |
| 0.3 Pyodide 导入 | 通过（Node 内置同版本 vendored Pyodide 等价验证） | `~/wm_bench/tools/p0_pyodide_import.js`，成功执行 `from world_model.core import WorldModel` 并完成更新 |
| 0.4 原始数据采集 | 通过 | `~/wm_bench/artifacts/p0/raw_challenge2_run1.jsonl`，赛题2 一局 220 帧，字段完整 |
| 0.5 基线记录 | 通过 | `~/wm_bench/artifacts/p0/baseline_challenge2.json`，赛题2 固定示例路线完成 8/8，总分 99.0，任务 40/40，规则 25/25，自主 15/15，效率 19/20 |

### 2.1 0.4 原始 JSONL 说明

采集时使用的比赛运行实例关闭了平台 PNG 视觉证据账本写入。原因是平台单局视觉证据硬上限为 20 MiB，约 91 次 `robot.observe()` 后即触发：

```text
Error: run exceeds the 20971520 byte vision evidence limit
```

关闭的是证据账本写入，不是摄像头、像素检测器或仿真本身。因此：

- 逐帧 `robot.observe()` 与 `robot.odometry()` 是平台真实返回。
- 该次运行记录不具备正式提交复算所需的视觉证据，不能当作 P0.5 或 P4 的成绩记录。
- P0.5 基线使用未关闭证据账本的固定示例路线单独完成，可正常复算。

JSONL 校验结果：

- 帧数：220。
- 每帧字段：`frame / observe / odometry`。
- `odometry` 字段：`forwardCm / rightCm / headingDeg / distanceCm / tick`。
- `observe` 契约字段：`category / categoryLabel / name / label / direction / bearingDeg / distanceCm / confidence / near / stable`。
- 实际覆盖类别：`target / distractor / obstacle / storage-zone / cleanup-zone`。

### 2.2 基线修复记录

为满足 0.1，修复了仓库中 4 个既有失败，均不属于 WorldModel 核心逻辑：

1. `projects/car-python/server.js`：本地登录路由恢复为参与者和管理员都可登录，匹配冻结的 `auth-access.test.js`。
2. `docker.env.example`：`CHENLONG_RUN_ARCHIVE_MAX_BYTES` 恢复为测试冻结的 `4294967296`。
3. `projects/car-python/tests/vision-recompute.test.js`：golden `observe` 结果补上 P1 新增的 `bearingDeg: 0`。
4. P1 的两处源文件改动本身不属于基线失败。

备份位于：

- `/tmp/wm_guiyang_p0_baseline_backup/`
- `/tmp/wm_guiyang_p1_backup/`

## 3. P1 平台改造：暴露数值方位角

### 3.1 代码改动

改动源文件 2 个：

- `projects/car-python/vision-pixel-core.js`
  - 新增 `bearingDegForBox(box)`。
  - `virtualPointDetection()` 与障碍物检测加入 `bearingDeg`。
  - `safeObservation()` 在检测带 `box` 时透出 `bearingDeg`。
  - 导出 `bearingDegForBox`，便于测试和复用。
- `projects/car-python/app.js`
  - `safeVisionObservation()` 透出 `bearingDeg`。

新增行数：

- `vision-pixel-core.js`：24 行。
- `app.js`：2 行。
- 合计 26 行，集中在 2 个源文件。

测试 golden 另补 1 行 `bearingDeg: 0`。

### 3.2 验收结果

| 验收项 | 结果 | 证据 |
|---|---|---|
| 1.1 无回归 | 通过 | 根仓库全量、car-python 全量测试均 0 失败 |
| 1.2 正确性 | 通过 | 10 个样本最大误差 0.0000°，门限 1.5° |
| 1.3 一致性 | 通过 | ±7.0° 内方向为中间，符号 10/10 一致 |
| 1.4 范围 | 通过 | 画幅左右边缘约 ±37.55°，不超过 ±37.6° |
| 1.5 改动量 | 通过 | 2 个源文件，合计新增 26 行 |

P1 数值验证报告：

`~/wm_bench/artifacts/p1/p1_bearing_verify.json`

## 4. P2 空间记忆接入

### 4.1 已完成代码

- 新增 `world_model/providers/guangyang.py`
  - `odometry_to_pose()`：平台 `forwardCm / rightCm / headingDeg` 转换为 `RobotPose`。
  - `observation_to_detection()`：按 `x = pose.x + d * sin(yaw + bearing)`、`z = pose.z + d * cos(yaw + bearing)` 转换。
  - `GuangyangProvider.stream()`：支持离线 JSONL 帧回放，供 P2 跑批复用。
  - 支持可配置 `distance_relative_std` 与 `heading_deg_std` 噪声。
- 修改 `world_model/decay.py`
  - `FovConfig.horizontal_fov_deg = 75.2`。
  - `FovConfig.max_range_m = 8.0`。
  - `class_half_life_scale` 增加 `target / distractor / obstacle / storage-zone / cleanup-zone`。
- 更新 `world_model/providers/__init__.py` 导出。
- 新增 `tests/test_guangyang_provider.py` 9 条用例。

### 4.2 已验证项

| 验收项 | 当前状态 |
|---|---|
| 2.1 定位精度 | 待 10 套布局跑批 |
| 2.2 轨迹数正确 | 待 10 套布局跑批 |
| 2.3 不裂轨 | 待 10 套布局跑批 |
| 2.4 不错并 | 单测覆盖两个同类目标不合并，10 套布局跑批待做 |
| 2.5 时效性 | 单测覆盖 3 秒内跌破 stale_threshold；平台真实抓取事件待接入 |
| 2.6 契约合规 | 已通过，`to_scene_observations()` 严格八字段 |
| 2.7 鲁棒性 | 噪声配置已实现；10 套布局指标待补 |

### 4.3 真实数据现状

已有一局赛题2 的 220 帧原始观测，可离线回放。尚未得到 10 套布局真值对照，因此 P2 的 2.1–2.4、2.7 还不能给出最终数字。

## 5. P3 目标选择与转向：算法层

### 5.1 已完成代码

新增 `~/wm_kit/selection/`：

- `turn.py`：最短转角归一化到 `(-180, 180]`。
- `graph.py`：仅用 `nodeId / fromNodeId / toNodeId / lengthCm / oneWay` 的 Dijkstra。
- `calibration.py`：由实测 `distance_cm / turn_deg / elapsed_ticks` 拟合 `cost = distance + k * abs(turn)` 中的 k。
- `selector.py`：候选代价计算与最优候选选择。

### 5.2 已验证项

新增 `tests/test_selection.py` 21 条用例，覆盖：

- 跨 0°、跨 180°、边界范围。
- 单行道路限制与 Dijkstra 最短路径。
- 合成样本恢复 k。
- 路径距离参与代价、短转角优先、20 组最短转角正确性主体。

WorldModel 全量测试当前 160 通过，0 失败。

### 5.3 未完成项

- P3.1：尚未用平台 `follow_road / take_exit` 的 `elapsedTicks` 采集 3 组转角 × 3 次重复实测。
- P3.3：欧氏最近与代价最优对照尚未用平台真实布局构造 10 组。
- P3.4：赛题2 全 10 套布局首选目标与离线穷举对照尚未执行。
- P3.5：静态检查尚未执行。

## 6. P4 规划闭环

尚未开始。下一步需要在 P2 跑批和 P3 标定完成后，接入：

- 感知 → 记忆 → 候选选择 → 拓扑规划 → `follow_road / take_exit` 执行。
- `frontClearanceCm / 左右余量` 与记忆中障碍物联合避障。
- 抓取失败、投放不可行时的重规划分支。
- 赛题2 全 10 套布局与赛题1 8 套布局泛化。

## 7. 当前产物索引

### WorldModel 仓库

- `~/wm_kit/world_model/providers/guangyang.py`
- `~/wm_kit/world_model/decay.py`
- `~/wm_kit/tests/test_guangyang_provider.py`
- `~/wm_kit/selection/`
- `~/wm_kit/tests/test_selection.py`

### 平台仓库

- `projects/car-python/vision-pixel-core.js`
- `projects/car-python/app.js`
- `projects/car-python/server.js`（基线修复）
- `projects/car-python/tests/vision-recompute.test.js`（契约 golden 修复）
- `docker.env.example`（基线修复）

### wm-bench

- `~/wm_bench/tools/p0_pyodide_import.js`
- `~/wm_bench/tools/p1_bearing_verify.js`
- `~/wm_bench/artifacts/p0/raw_challenge2_run1.jsonl`
- `~/wm_bench/artifacts/p0/baseline_challenge2.json`
- `~/wm_bench/artifacts/p1/p1_bearing_verify.json`

## 8. 下一步执行顺序

1. 补 P3.1：平台 `follow_road / take_exit` 实测标定 k，并留原始 tick 数据。
2. 补 P2 跑批：赛题2 全 10 套布局，采集真值、逐帧观测、快照与定位误差。
3. 接 P2.5：抓取目标物、释放混淆物两个世界变更事件，验证 3 秒内旧轨迹跌破 STALE。
4. 补 P3.3 / P3.4：构造欧氏最近与代价最优不一致场景，并做 10 套布局离线穷举对照。
5. 进入 P4：规划闭环、避障、重试分支、泛化验证。
