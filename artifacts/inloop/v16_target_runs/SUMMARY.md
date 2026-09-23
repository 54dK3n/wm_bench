# v16 在环运行摘要

- 程序：`/Users/ken/wm_bench/programs/world_model_target_delivery.py`
- `PROGRAM_VERSION`：`wm-memory-v16-20260921`
- 文件 SHA256：`b46c781c03ce938f4f242a7d4ec2042236ab8d9d15558976c1504848770a5eb2`
- 本目录日志：`attempt-1.json` / `attempt-1.log`

## 本轮改了什么

接近阶段（确认完成之后）：

1. 0.25 m 以外不再使用直线 `robot.forward`。
   - 改为单步 `follow_road(..., maxCm=10, obeySpeedLimit=True)`。
   - 每步后不调用 `observe`，只用 `odometry` + WorldModel 坐标重算目标距离。
2. 距离不再下降或 `<=0.25m` 时停止。
   - 设置 `APPROACH_FOLLOW_STEP_CM=10.0`。
   - 用 `best_distance_m` 与 `APPROACH_IMPROVE_M=0.005` 判断是否还有下降；连续不下降则停止。
3. 停止后如果距离 `<=0.25m`：
   - 原地 `left_angle/right_angle` 转向 WorldModel 目标方向。
   - 然后 `approach(max_steps=1)` + `grab`。
4. 所有 `follow_road` 的实际 `distanceCm` 计入 `forward_after_last_observe_cm`。
5. 停止时仍 `>0.25m`：
   - 打印 `approach_min_distance_failed`，包含最小距离、当前距离、`roadId`、`onRoad`、`required_m`。
   - 直接失败，不离开道路去追目标。

原因：

- v13 在环日志证明 35 cm 直线 `forward` 在 `bailu-west-arc` 弯道上偏出道路 13.3 cm。
- 所以接近阶段必须沿道路小步 `follow_road`，避免切线与弯道分离。

## 本目录运行结果

`attempt-1`：

- 确认阶段在该随机布局中没有完成（第三个采样点在路口反复 0cm，触发 `confirmation_failed/sample_duplicate`）。
- 因此本局尚未进入接近阶段，本轮接近阶段改动没有被这次运行覆盖到。
- 程序按 fail-fast 结束，没有离路抓取。

## 已有可核对参考

`../v13_target_runs/attempt-1.json`：

- 确认阶段新移动方式通过：3 次命中 44 / 73 / 87 cm，最后 WorldModel 距离 0.87 m，相邻间距 0.199 / 0.150 m。
- 旧接近阶段因 35 cm 直线 `forward` 在弯道离路，触发 `approach_on_road_violation`。
