# WorldModel × 广阳岛仿真平台 集成方案

> 版本 v1 · 2026-09-16
> 作者 杨铮
> 状态 待带教确认
>
> **执行约束：本文档为后续实现与验收的基线。后续执行必须严格按照本文档的分阶段任务、验收标准、总验收门限与“明确不做的事”执行；任何偏离或变更，须先更新本文档并重新确认。**

## 0. 一句话结论

广阳岛竞赛平台(robot_competition)可以直接作为 WorldModel 的执行与评测环境。需要在平台侧做一处约 15 行的改动(暴露数值方位角)，WorldModel 侧新增一个 provider 文件，现有的关联与衰减模块不修改。

## 1. 实现目标

把 WorldModel 从"读 JSON 模拟场景"推进到"在带噪声的真实仿真闭环中工作"，并用平台自带的评分体系产出可交付的量化证据。

拆成三部分：

| # | 名称 | 内容 | 对应现有代码 |
|---|---|---|---|
| 1 | 空间记忆 | 把摄像头观测换算成地图坐标；同一物体多次观测的合并；同类多实例的区分；旧记录的时效判定 | `world_model/association.py`、`decay.py` 已实现，需接入真实数据 |
| 2 | 目标选择与转向 | 在记忆基础上比较候选目标代价(路径距离 + 转向代价)，选最优并计算最短转角 | 新增 |
| 3 | 规划闭环 | 避障与路径规划，串起感知→记忆→决策→执行，完成完整任务 | 新增 |

## 2. 现状盘点

以下均为在本地实际验证过的事实，非推测。

### 2.1 WorldModel 仓库

- **零第三方依赖。** 全仓库仅使用 `math / json / time / datetime / copy / dataclasses / enum / itertools / pathlib / typing / abc / inspect / sys`，pytest 仅出现在测试中。
- `PerceptionProvider` 抽象已就位：`stream() -> Iterator[(timestamp, RobotPose, List[Detection])]`。
- `CameraDetectorProvider` 是待实现桩，注释中的方法(检测框底边中点 → 相机射线 → 地平面求交)与本平台的传感器形态一致。
- 对外契约 `scene_observations` 字段：`name / aliases / x / z / radius_cm / source / timestamp / confidence`。

现有默认配置：

| 参数 | 当前值 | 说明 |
|---|---|---|
| gate_distance_m | 0.5 | 基础关联门控 |
| max_speed_mps | 0.5 | 门控随 dt 放大的速率 |
| max_gate_distance_m | 2.0 | 门控上限 |
| confirm_hits | 3 | TENTATIVE → CONFIRMED |
| stale_threshold | 0.50 | → STALE |
| lost_threshold | 0.15 | → LOST，移出快照 |
| half_life_in_fov_missed_s | 1.5 | 视野内漏检衰减半衰期 |
| half_life_out_of_fov_s | 60.0 | 视野外衰减半衰期 |
| FovConfig | 70° / 4.0m | 与平台不符，需改 |

### 2.2 广阳岛平台

已验证可运行：

- `node --test tests/competition-core.test.js` → 74/74 通过
- `node tools/validate-guangyang-safe-route.js` → 8/8，零碰撞，零违规，98.8 分
- 物理、任务判定、评分三层可脱离浏览器在纯 Node 中 require。唯独 640×480 相机帧需要 WebGL 渲染。

Python 运行环境：Pyodide，内置 351 个包。numpy / scipy / networkx / shapely / opencv-python / scikit-learn 可用；torch / onnxruntime 不可用。仿真模式对 import 无限制(只有真车模式锁死为仅 math)。因 WorldModel 零依赖，该限制不构成问题。

相机参数(硬编码，可直接用于标定)：

| 参数 | 值 |
|---|---|
| 分辨率 | 640 × 480 |
| 垂直 FOV | 60° |
| 推导焦距 | 415.7 px |
| 推导水平 FOV | 75.2° |
| 挂载位置 | x=0, y=0.54 m, z=−0.43 m |
| 俯仰角 | −8° |
| 近/远平面 | 0.04 m / 30 m |

观测接口 `robot.observe()` 返回：

```json
{
  "category", "categoryLabel", "name", "label",
  "direction", "distanceCm", "confidence", "near", "stable"
}
```

- 不返回世界坐标，不返回物体实例编号(平台刻意设计)。
- `direction` 只有 左 / 中间 / 右 三档，阈值为画幅的 0.42 / 0.58 → "中间"约等于 ±7.0°。这是本方案唯一的硬阻塞。
- `distanceCm` 由目标像素宽度反推物理宽度得到，输出钳制在 0.05–8 m。各类物理宽度：红球/混淆物 0.44 m，障碍物 0.46 m，存放点/清理点 0.38 m。
- 单帧同类最多返回区域数：target 3、distractor 3、obstacle 6、storage-zone 4。

其他可用接口：`odometry()`(相对起点的前向/右向位移、相对航向、累计里程)、`road_state()`(当前道路、进度、两端节点、可选出口、左右余量、前方净空)、`map_graph()`(无坐标路网)、`mission()`(道路级锚点)、`task_state()`、`grab / release / holding / release_preview`、`follow_road / take_exit`(返回 elapsedTicks，20 ms/tick)。

赛题配置：

| 赛题 | 目标物 | 混淆物 | 障碍物 | 检查点 | 地图池 |
|---|---|---|---:|---:|---:|
| R2-GYI-MVP-01 | 1 | 1 | 1 | 4 | 8 套 |
| R2-GYI-MVP-02 | 2 | 2 | 2 | 6 | 10 套 |
| R2-GYI-MVP-03 | 3 | 3 | 3 | 8 | 12 套 |

目标物/混淆物/障碍物/检查点位置按 seed 随机化；存放点恒为 1 个且不随机(`storages.length !== 1` 会直接抛错)。

评分：任务 40 / 规则 25 / 自主 15 / 效率 20。平台自带算法验收线：仅用公开接口完成 8/8、零碰撞、零规则违规、总分 ≥ 95。

### 2.3 octos_robots

**不纳入本方案。** 依赖 `urllib.request` 与 `subprocess` 调用外部 LLM 和 skill 进程，二者在 Pyodide 中均不可用；且该方向已归档。其 `benchmarks/run_bench.py` 的跑批结构可作为 wm-bench 的参考，但不复用代码。

## 3. 架构决策

**三仓库，不合并。**

```text
WorldModel                          纯 Python，零依赖，不感知任何仿真
  ├── world_model/association.py    复用，不改
  ├── world_model/decay.py          复用，仅改 FovConfig 参数
  ├── world_model/providers/
  │     ├── mock.py                 保留，用于单测
  │     └── guangyang.py            ★ 新增
  ├── selection/                    ★ 新增(第二部分)
  └── planning/                     ★ 新增(第三部分)

robot_competition                   平台，只改 vision-pixel-core.js + app.js
  └── 暴露 bearingDeg

wm-bench                            ★ 新建，跑批与报告
```

不合并的理由：

- 平台是 JS + 浏览器，WorldModel 是 Python。合并后改一行记忆逻辑需重启整个前端。
- 平台是第三方代码，只改 15 行时升级容易对齐；合并后无法再分离。
- `PerceptionProvider` 抽象的价值正是可换源。合并会把 WorldModel 焊死在这一个平台上，以后接 SimCar 或真机时要重做。

## 4. 分阶段计划

### P0 — 环境打通与基线固化

目标：平台能跑起来，WorldModel 能在 Pyodide 中导入，并留下基线数据。

任务：

- `node server.js` 起服务，手动完成一局赛题2
- 把 WorldModel 源码打包注入 Pyodide 运行环境，验证 `import world_model` 成功
- 写一段最小脚本，每步打印 `robot.observe()` 与 `robot.odometry()` 原始返回，存成 JSONL

验收标准(全部满足才算过)：

| # | 项 | 判定 |
|---|---|---|
| 0.1 | 平台自检 | `node --test tests/*.test.js` 全通过，失败数 = 0 |
| 0.2 | WorldModel 自检 | pytest 全通过(当前 49 个用例)，失败数 = 0 |
| 0.3 | Pyodide 导入 | 浏览器控制台无报错完成 `from world_model.core import WorldModel` |
| 0.4 | 原始数据采集 | 赛题2 一局完整 JSONL，≥ 200 帧，字段完整无缺失 |
| 0.5 | 基线记录 | 手写脚本跑完赛题2 一局并记录总分，作为后续对照基线 |

回退条件：若 0.3 失败(Pyodide 注入方式不通)，改为在浏览器外用 Node 驱动 headless Chrome，WorldModel 跑在外部 Python 进程，通过 CDP 交换消息。工期 +3 天。

### P1 — 平台改造：暴露数值方位角

目标：让 `observe()` 返回数值角度，而非三档文字。

任务：

- `vision-pixel-core.js`：在 `projectQuery` 中，由检测框中心 x 与焦距 415.7 px 计算 `bearingDeg`，右为正
- `app.js` 的 `safeVisionObservation()`：透出 `bearingDeg` 字段
- 保留 `direction` 原字段不动，确保平台原有测试与示例不受影响

验收标准：

| # | 项 | 判定 |
|---|---|---|
| 1.1 | 无回归 | 改动后 `node --test tests/*.test.js` 仍全通过 |
| 1.2 | 正确性 | 构造已知位姿，`bearingDeg` 与真值角度误差 ≤ 1.5°，取 10 个样本点 |
| 1.3 | 一致性 | `bearingDeg` 落在 ±7.0° 内时，`direction` 必为"中间"；符号与左/右一致，10/10 样本无冲突 |
| 1.4 | 范围 | `bearingDeg` 绝对值不超过 37.6°(半水平 FOV)，无越界样本 |
| 1.5 | 改动量 | 改动集中在 2 个文件，`git diff --stat` 新增行数 ≤ 30 |

### P2 — 空间记忆接入(第一部分)

目标：WorldModel 在真实带噪观测下建立并维护地图坐标。

任务：

- 新建 `world_model/providers/guangyang.py`：
  - `observe()` → `Detection(class_name, x, z, confidence, radius_cm, source, timestamp)`
  - 极坐标转世界坐标：`x = pose.x + d·sin(pose.yaw + bearing)`，`z = pose.z + d·cos(pose.yaw + bearing)`
  - `odometry()` → `RobotPose(x, z, yaw_rad, pose_uncertainty_cm)`
- 修正 `FovConfig`：`horizontal_fov_deg 70 → 75.2`，`max_range_m 4.0 → 8.0`
- 增加 `class_half_life_scale` 条目：target / distractor / obstacle / storage-zone
- 在 `odometry()` 读数上叠加可配置噪声(平台本身是确定性的，无漂移)
- 关于"旧记录失效"的测试来源：平台世界是静态的，但一局中存在两次真实的世界变更——机器人抓起目标物(原位置记录立即失效)、把混淆物释放到路外(位置改变)。这两个事件是天然的时效性测试用例，不需要改平台。

验收标准：

| # | 项 | 判定 |
|---|---|---|
| 2.1 | 定位精度 | 对 CONFIRMED 轨迹，`(x,z)` 与真值误差中位数 ≤ 15 cm，P90 ≤ 35 cm。样本：赛题2 全 10 套布局 |
| 2.2 | 轨迹数正确 | 每局结束时，各类别活跃轨迹数 = 该布局真实物体数。10 套布局中 ≥ 9 套正确 |
| 2.3 | 不裂轨 | 单个真实物体被拆成 ≥ 2 条 CONFIRMED 轨迹的次数，全 10 局合计 ≤ 2 |
| 2.4 | 不错并 | 两个同类物体被并成 1 条轨迹的次数，全 10 局合计 = 0 |
| 2.5 | 时效性 | 抓起目标物后 3 秒内，原位置轨迹置信度跌破 `stale_threshold` (0.50)。10/10 局成立 |
| 2.6 | 契约合规 | `to_scene_observations()` 输出字段严格等于契约八字段，类型与取值范围校验全通过 |
| 2.7 | 鲁棒性 | 在 odometry 叠加 2% 距离误差 + 每次转向 1° 航向误差后，2.1 的中位误差 ≤ 30 cm，2.4 仍为 0 |

必须留档的产物：每局一份 JSONL(逐帧 detections + pose + 快照) + 一张 10 局汇总表。

### P3 — 目标选择与转向(第二部分)

目标：在记忆基础上选出真正代价最小的候选目标，并给出最短转角。

任务：

- 标定转向代价：用 `follow_road / take_exit` 的 `elapsedTicks`，实测 90°、180° 转向与 100 cm 直行的耗时，拟合出 `cost = distance_cm + k · |turn_deg|` 中的 k
- 路径距离用 `map_graph()` 的 `lengthCm` 跑 Dijkstra，不用欧氏距离
- 最短转角：结果归一化到 (−180°, 180°]
- 候选集：赛题2 的 2 个目标物(存放点只有 1 个，不作为候选)

验收标准：

| # | 项 | 判定 |
|---|---|---|
| 3.1 | k 已标定 | 给出实测数据表(≥ 3 组转角 × 3 次重复)与拟合的 k 值，残差 ≤ 10% |
| 3.2 | 最短转角 | 20 组构造用例(含跨 0° 与跨 180° 各 5 组)全部正确，20/20。例：目标方位 350°、当前朝向 10° → 必须输出 −20°，不是 +340° |
| 3.3 | 选择正确 | 10 组"欧氏最近 ≠ 代价最优"的构造场景中，选出解析解最优项 ≥ 9/10；其中欧氏基线的正确率必须明显更低(作为对照) |
| 3.4 | 端到端 | 赛题2 全 10 套布局，首选目标与离线穷举最优解一致 ≥ 8/10，不一致的 2 局须逐条给出原因分析 |
| 3.5 | 不依赖真值 | 代码中不出现 `get_truth` 或任何硬编码坐标；静态检查通过 |

### P4 — 规划闭环(第三部分)

目标：感知→记忆→决策→执行完整跑通，完成赛题2 全任务。

任务：

- 避障：结合 `road_state()` 的 `frontClearanceCm / 左右余量` 与记忆中的障碍物位置
- 路径规划：`map_graph()` 拓扑规划 + 局部 `follow_road / take_exit` 执行
- 失败重试：抓取失败、`release_preview()` 判定不可投放时的重规划分支
- 全流程：找目标物 → 抓取 → 送存放点 → 处理混淆物 → 过检查点 → 返回停车区

验收标准：

| # | 项 | 判定 |
|---|---|---|
| 4.1 | 完成率 | 赛题2 全 10 套布局，完成 8/8 的局数 ≥ 8/10 |
| 4.2 | 零碰撞 | `collisionCount = 0` 的局数 ≥ 9/10，全部 10 局合计碰撞 ≤ 2 |
| 4.3 | 零违规 | `ruleViolations` 为空的局数 = 10/10 |
| 4.4 | 分数 | 完成局的总分中位数 ≥ 95，最低分 ≥ 85 |
| 4.5 | 稳定性 | 同一布局重复跑 3 次，总分极差 ≤ 5 分 |
| 4.6 | 重规划生效 | 至少 3 局触发过抓取失败或投放不可行的重试分支，且最终仍完成任务 |
| 4.7 | 无硬编码 | 代码中不含任何布局相关的坐标常量；换用未见过的布局(赛题1 的 8 套)仍能完成 ≥ 5/8 |

**4.7 是本阶段最重要的一条。** 只在见过的布局上得高分证明不了泛化。

### P5 — 总验收与交付

交付物：

- 主表 — 赛题2 × 10 套布局：

| 布局 | 完成 | 总分 | 任务 | 规则 | 自主 | 效率 | 碰撞 | 违规 | 用时(s) | 定位中位误差(cm) |
|---|---|---|---|---|---|---|---|---|---|---|
| map-01 … map-10 | | | | | | | | | | |

末行给出：完成率、总分中位数/最低分、碰撞总数、违规总数。

- 泛化表 — 赛题1 × 8 套布局，同样字段(对应 4.7)
- 技术报告 — 含 P2 的定位误差分布图、P3 的 k 标定数据、失败局逐条归因
- 可复现命令 — wm-bench 一条命令重跑全部，输出与报告中的表一致

总验收(一票否决)：

| # | 项 | 门限 |
|---|---|---|
| A | 赛题2 完成率 | ≥ 80% (8/10) |
| B | 规则违规 | 全部 10 局合计 = 0 |
| C | 碰撞 | 全部 10 局合计 ≤ 2 |
| D | 总分中位数 | ≥ 95(对齐平台自带算法验收线) |
| E | 泛化 | 未调优的赛题1 布局完成率 ≥ 60% (5/8) |
| F | 无真值泄漏 | 代码静态检查：无 `get_truth`、无硬编码坐标 |
| G | 可复现 | 他人在干净环境按文档复跑，主表数字可复现，偏差 ≤ 5% |

## 5. 明确不做的事

| 项 | 原因 |
|---|---|
| 合并三个仓库 | 见 §3 |
| 引入 octos_robots | 依赖在 Pyodide 中不可用，且方向已归档 |
| 多存放点("最近的桶") | 平台 schema 硬限制单存放点，改动涉及布局校验、3D 渲染、投放判定三处。需带教确认是否必须，默认不做 |
| 在平台中引入 torch 模型 | Pyodide 无 torch。若后续需要，模型须在浏览器外运行，通过接口喂动作 |
| 动态物体(自行移动/消失) | 平台不支持；时效性测试改用抓取/释放这两个天然世界变更事件 |
| 真机部署 | 本任务范围为仿真环境测试 |

## 6. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| Pyodide 注入 WorldModel 源码方式不通 | P0 阻塞 | 回退到 headless Chrome + 外部 Python 进程，工期 +3 天 |
| `distanceCm` 由像素宽反推，远距离误差大 | P2 的 2.1 不达标 | 增加"仅采信 `stable=True` 且距离 ≤ 260 cm 的检测"门控；必要时放宽 P90 门限并在报告中说明 |
| 两个红球在同一帧内且距离相近 | P2 的 2.4 错并 | 关联门控已随 dt 自适应；必要时对同类多实例启用更严格的门控上限 |
| 平台确定性无漂移，鲁棒性验证不充分 | 结论可信度 | P2 的 2.7 强制叠加人工噪声，并在报告中同时给出有噪/无噪两组数字 |
| 时间不足 | P4 交付不全 | P2 完成即已覆盖三部分中价值最高的一部分，可单独交付并在报告中说明进度 |

## 7. 待带教确认

- "最近的桶"(多存放点)是否为必须项？若是，需追加平台 schema 改动，工期 +1 周。
- 验收以赛题2 为准是否认可？(赛题1 单物体测不出合并与区分)
- 平台源码的修改是否需要向平台方同步？
- 第三部分若时间不足，能否以 P2 + P3 单独验收？

---

## 附：执行与验收纪律

1. 后续所有实现、提交、跑批、报告，必须逐项对照本文档的 P0–P5 验收标准与总验收 A–G 门限。
2. 不得擅自扩大范围或跳过低成本验证项；§5 中列出的内容默认不做。
3. 若发现文档与代码事实不一致，先暂停对应实现，记录证据，并更新本文档后再继续。
4. 所有量化结论必须可从留档产物复现：JSONL、汇总表、k 标定数据、技术报告、wm-bench 命令。
5. 任何验收不达标项不得用“后续优化”带过；必须在报告中给出未达标原因、影响与补救计划。
