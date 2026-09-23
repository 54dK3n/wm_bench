# F2 前置验证失败报告（停止后续 F1/F3）

结论：浏览器仿真可以启动，但当前交付的 planner **不能在赛题2中跑完一局任务**。
按任务指令，F2.1/F2.2/F2.5 与 F4 无法完成，因此停止后续 F1/F3 工作。

## 1. 浏览器仿真可启动
- 最小 JSON 程序和 planner 都能进入 `running program`。
- 说明 headless Chrome、本地服务、注册/选任务链路基本正常。

## 2. 失败一：证据账本 20 MiB 上限
- 运行：`node tools/inloop_driver.js --mission guangyang2 --program programs/guangyang_planner.py --timeout-ms 240000`
- 结果：`/tmp/preflight_clean.json`
- wallSeconds：191.17
- 分数：52.3（任务 12.3/40）
- 错误：
  ```text
  pyodide.ffi.JsException: Error: run exceeds the 20971520 byte vision evidence limit
  ```
- 位置：
  - `scan_and_grab`
  - `robot.approach`
- 含义：
  - planner 的 observe/approach 次数超过平台单局视觉证据上限。
  - 这不是定位算法问题，是采集/执行工程约束。
  - 使用 `--disable-evidence` 可以绕过该上限，但分数不满足正式提交证据要求。

## 3. 失败二：front_clearance 卡死
- 运行：`--disable-evidence`
- 结果：`/tmp/preflight_noev.json`
- wallSeconds：96.65
- 分数：52.3（任务 12.3/40）
- 错误：
  ```text
  RuntimeError: 抵达节点前被安全停止：front_clearance
  ```
- 位置：
  - `pass_checkpoint`
  - `go_to_anchor`
  - `node_state`
  - 道路：`east-inner-south`
- 已尝试：
  - 在 `node_state` 中增加最多 3 次低速后退+重新对齐。
  - 仍出现 `front_clearance_retry_exhausted`。
  - 2026-09-19 后续 run 在 `oil-south` 路线进入 `robot.approach` 后报 `程序已停止`。
  - 另一轮在第二目标扫描前报平台“参数类型不正确”。
- 含义：
  - 规划器还无法稳定穿过动态/静态障碍，也不能保证完整跑完 target→storage→distractor→checkpoint→return 状态机。

## 4. 失败三：平台赛次启动偶发失败
- 结果：`/tmp/instr_planner.json`
- 错误：
  ```text
  比赛场次启动失败
  composite delivery delivery-target-storage guangyang-target-2 is missing from the interaction definition
  ```
- 目前判断：
  - 不是每次都出现；
  - 可能与残留浏览器/多进程并发或赛次分配状态有关；
  - 需要平台侧或驱动侧进一步定位，不能当作 planner 通过依据。

## 5. 证据文件
目录：`wm_bench/artifacts/inloop/preflight_failures/`
- `evidence_limit.json/.log`
- `front_clearance.json/.log`
- `approach_stopped.json/.log`
- `type_error_line474.json/.log`
- `simulator_start_failed.json/.log`
- `planner_early_exit.json/.log`
- `guangyang_planner_preflight_variant.py`

## 6. 停止点
按批准流程：
- 不继续 F1 的 metrics.py/聚合分离修改。
- 不继续 F3 的口径 A/B 报告修改。
- 不重出正式 2.1/2.2 结论。
- 不声称 planner 在环通过。

需要先解决 planner 的视觉证据上限与道路前向净空卡死问题，并确认赛次启动稳定性后，才能继续 F1/F2/F3/F4。

## 补充：优先级 1 定性结果（2026-09-19）
- 最小程序只调用 `mission()`，不使用 planner；赛题2 运行 10 次。
- `guangyang-target-2 is missing from the interaction definition` 出现 **0/10**。
- 证据：`artifacts/inloop/preflight_failures/target2_minimal/SUMMARY.json`。
- 定性：不能判定为平台必现缺陷；现有证据指向 planner 的调用顺序/状态机问题，归入优先级 3。
