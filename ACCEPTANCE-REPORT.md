# ACCEPTANCE-REPORT — WorldModel 验收结果

测试立场：假设实现是错的并设法证明。离线层使用构造数据；在环层只认实际运行产物。

## 结果总表

| ID | 验收项 | 实测值 | 门限 | 结论 |
|---|---|---|---|---|
| 1.1 | 平台回归 | competition-core 74/74，vision-recompute 9/9 | 0 失败 | 通过 |
| 1.2 | bearingDeg 公式精度 | 平台 P1 公式级验证已通过；在环旧数据不作为本轮新增判定 | ≤ 1e-9° | 平台回归通过 |
| 1.3 | 与 direction 一致性 | 平台 P1 方向一致性已通过；在环旧数据不作为本轮新增判定 | 无冲突 | 平台回归通过 |
| 1.5 | letterbox 前提注释 | 已在 bearingDegForBox 上方增加注释 | 必须 | 通过 |
| 2.0 | provider 坐标约定自检 | 正式 PASSED / 诊断 FAILED | 通过；诊断应失败 | 通过 |
| 2.1 | CONFIRMED 轨迹定位误差 | 旧数据重算见 F1 节；新在环数据 BLOCKED，不填数字 | 中位 ≤ 15 cm，P90 ≤ 35 cm | 旧数据失败；新在环 BLOCKED |
| 2.1b | 幽灵轨迹数 | BLOCKED：在环数据无效与 planner 未完成，未填数字 | 10 局合计 ≤ 5 | BLOCKED |
| 2.2 | 轨迹数等于真实物体数 | 离线构造 正式 PASSED / 诊断 FAILED；在环口径 A/BLOCKED | ≥ 9/10 | 离线构造通过；在环 BLOCKED |
| 2.3 | 不裂轨 | 正式 PASSED / 诊断 PASSED | 10 局合计 ≤ 2 | 通过 |
| 2.4 | 不错并 | 正式 PASSED / 诊断 FAILED | = 0 | 通过 |
| 2.5 | 抓取后 3 s 跌破 STALE；LOST 不物理删除 | 正式 PASSED / 诊断 PASSED | 10/10 | 通过 |
| 2.6 | 契约八字段；to_contract 可用 | 正式 PASSED / 诊断 PASSED / 正式 PASSED / 诊断 FAILED | 全通过 | 通过 |
| 2.7 | 有噪鲁棒性 | 正式 PASSED / 诊断 FAILED | 中位 ≤ 30 cm，P90 ≤ 60 cm，错并 = 0 | 通过 |
| 3.2 | 最短转角 | 正式 PASSED / 诊断 PASSED | 20/20 | 通过 |
| 3.3 | 代价最优 | 正式 PASSED / 诊断 PASSED | ≥ 9/10 | 通过 |
| 3.4 | 首选目标 | BLOCKED：无有效在环规划数据 | ≥ 8/10 | BLOCKED |
| 3.5 | 无真值泄漏、无硬编码坐标 | 正式 PASSED / 诊断 PASSED | 静态检查通过 | 通过 |
| F3.5 | D5 误杀率与过滤精确率 | 独立判据：误杀率 39.21%，过滤精确率 91.74% | 误杀率 ≤ 2%，精确率 ≥ 95% | 失败 |
| 4.1 | 完成 8/8 局数 | BLOCKED：planner 未能在浏览器中稳定完成赛题2 | 原门限不变 | BLOCKED |
| 4.2 | 零碰撞 | BLOCKED：planner 未能在浏览器中稳定完成赛题2 | 原门限不变 | BLOCKED |
| 4.3 | 零规则违规 | BLOCKED：planner 未能在浏览器中稳定完成赛题2 | 原门限不变 | BLOCKED |
| 4.4 | 总分 | BLOCKED：planner 未能在浏览器中稳定完成赛题2 | 原门限不变 | BLOCKED |
| 4.5 | 重复稳定性 | BLOCKED：planner 未能在浏览器中稳定完成赛题2 | 原门限不变 | BLOCKED |
| 4.6 | 重规划分支 | BLOCKED：planner 未能在浏览器中稳定完成赛题2 | 原门限不变 | BLOCKED |
| 4.7 | 泛化 | BLOCKED：planner 未能在浏览器中稳定完成赛题2 | 原门限不变 | BLOCKED |

## F1 百分位与聚合修正

- `wm_bench/metrics.py::percentile_linear([5.0, 8.7, 9.6, 17.9, 22.7, 140.8], 90)` → **81.75**。
- n=0 返回 `None`；n=1、n=2 均有单测；不变量断言使用 `min <= median <= p90 <= max`。
- matched 判定改用 `truth_associations + match_radius`，不再使用 1.0 m / 100.0 cm 误差阈值。
- `d5_filtered_detections` 从 3354 变为 1063：全量 per_map 合计仍为 3354，1063 只累加 4 个有效布局；6 个 INVALID_SAMPLE 布局的过滤数 2291 按 F2 有效性规则排除，不是 D5 掩码变更。
- 正式模式旧数据重算：跑了 10 局，有效 4 局，无效 6 局；median 13.75，P90 **81.75**，confirmed 6，matched 5，ghost 1。旧数据 2.1 按真实 P90 判 **失败**。
- 诊断模式旧数据重算：median 89.9，P90 **123.82**，满足 P90 ≥ median。

## 可复现命令

```bash
cd world_model_package
WORLD_MODEL_ROOT=$PWD python3 -m pytest -q
cd wm_bench && PYTHONPATH=.. python3 run.py --out ../artifacts/inloop --skip-explore --no-planner
python3 report.py
```

## 在环层阻塞与优先级定性

### 优先级 1：`guangyang-target-2` 缺失（重做后）
- 已修复最小脚本 `wm_bench/programs/minimal_target2_flow.py`，流程为：
  `mission() → 接近 target-1 → grab → 到存放点 → release → 接近 target-2 → grab → release`。
- 已取得成功完成的完整流程运行，例如 attempt-2、attempt-4、attempt-10。
- 有效性字段：
  - `runs_attempted = 18`
  - `runs_reached_target2_delivery = 3`
  - `target2_missing_occurrences = 0`
  - `first_grab_true_runs = 5`
  - `no_result_runs = 11`（多为浏览器页面导航 timeout，与 target-2 缺失无关）
- 结论：**无法构造 10 次有效运行**；在已完成的有效运行中未出现 `guangyang-target-2 is missing`。因此 priority-1 仍未定性，不能判定为平台缺陷，也不能用 0/18 直接归因。需在环境稳定后补足 10 次 `target2_release == true` 的有效运行。
- 证据：`artifacts/inloop/preflight_failures/target2_validity/SUMMARY.json`。

### 优先级 2：视觉证据 20 MiB 预算
- 平台硬上限：`20 * 1024 * 1024 = 20,971,520` bytes。
- 实测 `observe()`：每次 1 帧，约 **227,070 bytes/次**。
- 实测 `approach(..., maxSteps=1)`：目标不存在时仍取帧/重试 **6 帧/次**，约 **1,297,668 bytes/次**。
- 20 MiB 约等于：
  - **92.36 次** `observe()`
  - **16.16 次** `approach(maxSteps=1)`
- 当前 planner 的完整一局调用数：**BLOCKED**。证据模式下 planner 在 `robot.approach` 处撞上 20 MiB；关闭证据后又在 `front_clearance` 失败，无法得到“完整一局调用数”。
- 证据：`artifacts/inloop/vision_budget.json`。

### 优先级 3：front_clearance 重规划
- 错误原文：
  ```text
  RuntimeError: 抵达节点前被安全停止：front_clearance
  front_clearance_retry_exhausted:east-inner-south
  ```
- 证据：`artifacts/inloop/preflight_failures/front_clearance.json`。
- 结论：`planning/` 的避障与重规划尚未形成有运行证据的闭环；FIXES.md 中相关表述已按此修正为“未完成运行验证”。

### 因在环阻塞无法判定的验收项
- 2.1、2.1b
- 3.4
- 4.1、4.2、4.3、4.4、4.5、4.6、4.7

以上项在结果表中标记 **BLOCKED**，不填数字、不做估算、不用离线数据代替。

## 视觉预算与空间记忆必要性

平台对单局视觉证据有硬上限：

- `20 * 1024 * 1024 = 20,971,520 bytes`

实测单次取帧成本：

| 调用 | 实测调用数 | 取帧数 | 总字节 | 单次字节 | 单次取帧数 |
|---|---:|---:|---:|---:|---:|
| `observe()` | 5 / 10 / 20 / 40 | 5 / 10 / 20 / 40 | 1,155,853 / 2,163,611 / 4,554,862 / 9,082,789 | 约 227,070 | 1 |
| `approach(..., maxSteps=1)` | 3 | 18 | 3,893,004 | 约 1,297,668 | 6 |

折合：

- 一局预算约等于 **92.36 次** `observe()`；
- 或约 **16.16 次** `approach(maxSteps=1)`。

结论：平台设计上不允许靠“每步实时观测”完成一局。WorldModel 的空间记忆不是可选优化，而是满足证据预算与自主导航的必要组件。

## D5 掩码审计（独立判据，F3.5 重新判定）

审计改用独立判据：`layout.objects` 的世界坐标 + `match_radius` 欧氏距离，
不再复用 `build_d5_artifact_mask.py` 的 `bearing_tol / ratio` 规则。

| 指标 | 数值 | 门限 | 结论 |
|---|---:|---:|---|
| 独立判据下的真实检测 | 607 | — | — |
| mask 命中真实检测 | 238 | — | — |
| mask 误杀率（召回侧） | **39.21%** | ≤ 2% | **失败** |
| mask 命中伪检测 | 2643 | — | — |
| mask 被过滤总数 | 2881 | — | — |
| mask 过滤精确率 | **91.74%** | ≥ 95% | **失败** |
| 合并 target-only 策略后的误杀率 | 89.79% | ≤ 2% | **失败** |
| 合并 target-only 策略后的精确率 | 83.77% | ≥ 95% | **失败** |

### 2881 与 3354 的口径差异
- `2881`：独立审计中的 **world-position mask 命中数**，不包含 target-only 类别策略，且不使用 target 距离尺度校正。
- `3354`：`summary.json` 的 `per_map` 合计，统计口径为口径 B：
  `allowed_categories=("target",)` + D5 mask + target distance_scale=1.25 后的 `filtered_total`。
- 独立审计中：
  - mask-only：2881
  - 仅类别策略额外过滤：477
  - 合并后原始坐标口径：3358
  - 与 summary 的 3354 相差 4，来自 target distance_scale=1.25 改变了 target 检测落点与 mask 重叠关系。
- 因此两者不是同一批统计，不能互相证明。

证据：`artifacts/inloop/d5_audit.json`。

## G 可复现修复

- `tests/acceptance/truth.py` 默认真值目录改为包相对：
  `Path(__file__).resolve().parents[2] / "wm_bench" / "artifacts" / "truth"`，
  环境变量 `WM_TRUTH_DIR` 保留为覆盖项。
- `test_3_5_truth_guard_blocks_algorithm_frames` 旧失败根因是**路径解析**，
  不是真值泄漏；守卫逻辑本身有效。现已修复。
- 干净环境（不设 `WM_TRUTH_DIR`）完整测试：
  `188 passed, 10 deselected`，失败数 0。
- `tools/verify_delivery_manifest.py` 增加干净环境完整套件检查，失败即 manifest 失败。
- 证据：`world_model_package` 干净根目录执行 `python3 -m pytest -q`。
