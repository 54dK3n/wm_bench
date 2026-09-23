# FIXES — 缺陷修复记录

## R1 `projects/car-python/server.js`
- 修改：`/api/v1/auth/login` 恢复 `authStore.login({ ...body, administratorsOnly: true })`。
- 原因：登录端点必须保持管理员边界，不能由普通注册用户复用。
- 验证：`diff` 与原始平台包一致；平台 `auth` 相关测试不受影响；`git diff` 中不得出现该文件。

## R2 `docker.env.example`
- 修改：`CHENLONG_RUN_ARCHIVE_MAX_BYTES` 恢复 `8589934592`。
- 原因：这是被误改的平台部署样例值。
- 验证：与原始平台包该文件字节一致；平台仓库 diff 不包含该文件。

## 1.5 `bearingDegForBox` 注释
- 修改：`projects/car-python/vision-pixel-core.js` 的 `bearingDegForBox` 上方增加 letterbox 前提注释。
- 原因：现实现依赖 `scale===1 && padX===0`；配置变化时函数会静默出错。
- 验证：平台 P1 公式逻辑未改；`vision-recompute` 9/9 通过。

## D1 provider 航向符号
- 修改：`world_model/providers/guangyang.py`
  - 顶部写死平台约定：`headingDeg` 左正、`rightCm` 右正、`bearingDeg` 右正。
  - 定义 WorldModel 内部 `yaw_rad` 正方向为右转。
  - `odometry_to_pose()` 中唯一转换：`yaw_rad = -radians(heading_deg)`。
  - 新增 `_assert_frame_convention()`，`GuangyangProvider.__init__` 启动自检，不符抛异常。
- 原因：原实现把 `headingDeg` 当右正，导致所有观测左右镜像。修复后正前方 1 m 在左转 90° 时落到 `(-1,0)`。
- 验证：
  - 正式模式 `test_2_0_provider_frame_convention` 通过；
  - 诊断模式 `WM_ACCEPT_HEADING_SIGN=-1` 下该测试失败，确认不存在第二处反转。

## D2 静态场景门控
- 修改：
  - `world_model/providers/guangyang.py` 增加 `GUANGYANG_STATIC_ASSOCIATION_CONFIG`：
    `gate_distance_m=0.30`、`max_speed_mps=0.0`、`max_gate_distance_m=0.30`。
  - `tests/acceptance/harness.py` 默认使用该静态配置；显式传入 `AssociationConfig()` 的 mock 场景不受影响。
  - 增加 `warn_if_gate_exceeds_half_min_gap()` 启动警告。
- 依据：10 套布局同类最小间距为 0.65 m；门控上限必须小于 0.65/2=0.325 m，因此取 0.30 m。
- 验证：
  - 正式模式 `test_2_4_no_false_merge` 10 局错并 0；
  - `test_2_3_no_track_split` 10 局裂轨 0。

## D3 LOST 记录不物理删除
- 修改：`world_model/core.py` 的 `get_object()` 在 `_objects` 找不到后继续查 `_lost`，再按名称/别名查归档。
- 原因：`_archive_lost()` 已归档，查询却只看活跃表，导致 LOST 不可取回。
- 验证：`test_2_5_lost_object_removed_from_snapshot_but_not_deleted` 通过；`snapshot()/get_scene()` 行为不变。

## D4 `to_contract()` 返回空列表
- 根因：`_contract_exclude_reasons()` 要求完整 `FrameQuality`；平台 `observe()` 无 `frameId`，provider 原来只在有 frameId 时构造 `FrameQuality`，导致全部轨迹被 `missing_frame_quality` 滤掉。
- 修改：
  - `observation_to_detection()` 始终生成 `FrameQuality`；无 frameId 时使用确定性 `guangyang:<timestamp>`。
  - `to_contract()` docstring 逐条列出过滤条件及默认值。
- 验证：`test_2_6_wm_to_contract_outputs_confirmed_tracks`、契约八字段测试通过。

## D5 地图纹理伪检测
- 修改：
  - `world_model/providers/guangyang.py` 增加 `GuangyangArtifactFilter`，支持按类别/世界位置过滤并统计数量；
  - `tools/build_d5_artifact_mask.py` 测试侧离线标定脚本；
  - `configs/guangyang_texture_artifacts.json` 版本化伪检测掩码。
  - 在环评估中允许按任务作用域只保留 target，并统计被过滤检测数；离线 provider 默认不启用。
- 原因：平台地图纹理在固定位置产生伪检测，平台侧不修时必须在 provider 入口过滤，不能污染 WorldModel。
- 验证：2.1 中位 13.75 cm、P90 22.7 cm、幽灵轨迹 1 条；D5 过滤 3354 条（写入 summary/TABLES/ACCEPTANCE 报告）。

## M1 planning/
- 新增：
  - `planning/graph.py`：公开拓扑 Dijkstra。
  - `planning/first_target.py`：暴露 `select_first_target()`，选图最短路最优 target。
  - `planning/__init__.py` 导出。
  - `wm_bench/programs/guangyang_planner.py`：完整任务状态机，处理多个 target/distractor、避障/重规划、`release_preview` 闭环、检查点、返航，并打印 `GY {"first_target": ...}`。
- 硬约束：只使用 `mission/map_graph/road_state/task_state/follow_road/take_exit/observe/approach/grab/release_preview/release/holding`，不调用真值接口，不写布局坐标。
- 验证：`test_3_4_first_target_uses_graph_shortest_not_euclidean` 通过；3.5 静态扫描 0 处。

## 测试与变异
- `tests/acceptance/offline`：正式模式 22/22 通过。
- `tests/acceptance/inloop`：marker 隔离，默认不跑。
- `tests/acceptance/conftest.py`：运行时变异注入，euclid_path 同时打中 selection 与 planning.first_target。
- `wm_bench/mutate.py`：正式模式 10 条对照全部绿→红，见 `MUTATION-REPORT.md`。
- `wm_bench/run.py`：一条命令跑在环并输出 `summary.json`、`TABLES.md`；默认使用交付规划程序。

## F0 交付边界（本轮）
- 新增交付包目录：
  - `robot_competition/` 平台包，只允许三文件 diff。
  - `world_model_package/` WorldModel 包，含 `world_model/`、`selection/`、`planning/`、`wm_bench/`、`tests/`、`tools/`、`configs/`、`artifacts/`。
- 新增 `tools/verify_delivery_manifest.py`：
  - 校验 FIXES/MUTATION/ACCEPTANCE 中引用的路径存在；
  - 交叉校验报告里的 median、P90、confirmed、matched、ghost、有效布局数能在 `artifacts/inloop/summary.json` 找到同值来源；
  - 校验 2.1b、3.4、4.x 行标 BLOCKED。

## F1 百分位与聚合缺陷（本轮）
- 修改文件：
  - 新增 `wm_bench/metrics.py`：
    - `percentile_linear()` 使用 numpy 默认 linear 插值；
    - n=0 返回 `None`，n=1/2 有单测；
    - `summarize_errors()` 断言 `min <= median <= p90 <= max`；
    - `summarize_localization()` 显式接收 confirmed / matched 两套数组。
  - 修改 `wm_bench/eval_inloop.py::evaluate_localization()`：
    - matched 判定改用 `truth_associations + match_radius`；
    - 不再使用 `e <= 1.0` 或 `e <= 100.0` 阈值；
    - 返回 `confirmed_errors_cm`、`matched_errors_cm`、`invalid_sample`。
  - 修改 `wm_bench/run.py::eval_localization_stage()`：
    - 删除本地最近邻 `p90(v)`；
    - confirmed 与 matched 分开聚合；
    - 无效布局 `confirmed_tracks == 0` 不计入 2.1 误差池，记录 `layouts_run` / `layouts_valid`。
  - 新增 `tests/test_metrics.py`：F1.1、边界 n=0/1/2、F1.2、F1.3。
- 旧数据重算：
  - 正式模式：median 13.75，P90 81.75，confirmed 6，matched 5，ghost 1，有效布局 4/10；2.1 判失败。
  - 诊断模式：median 89.9，P90 123.82，满足 P90 >= median。
- 注意：F1.1 单测期望 81.75；旧聚合函数曾取最近邻 22.7，已废弃。

## F2 前置验证（本轮，BLOCKED）
- 已执行浏览器可跑性预检，证据保留在 `artifacts/inloop/preflight_failures/`。
- 阻塞：
  - 证据开启时 `robot.approach` 撞平台 20 MiB 视觉证据上限；
  - 证据关闭时 planner 在 `front_clearance` 失败；
  - 赛次启动偶发 `guangyang-target-2 missing from interaction definition`。
- 最小 mission 程序 10 次试验中该平台错误出现 0/10，因此未定性为平台必然缺陷，归入 planner 状态机/调用顺序问题。
- F2 的在环有效布局、样本量、超时占比均未完成，不填数字。

## F3 评测口径（本轮，未完成）
- 口径 A/B 双套数字、D5 审计、误杀率/过滤精确率尚未产出。
- 2.2 的在环判定必须等 F2/F3 完成，当前标记 BLOCKED。

## F4 2.2 复核（本轮，BLOCKED）
- 在环 2.2 依赖口径 A 的有效在环数据；当前无有效数据，不能判定，也不缩减类别范围。

## 修正 M1 表述
- 原 `FIXES.md` 中“避障与重规划闭环”表述不准确；当前 planning 的道路前向净空重规划 **未通过运行验证**，已在报告中改为 BLOCKED/未验证。
