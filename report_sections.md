
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
