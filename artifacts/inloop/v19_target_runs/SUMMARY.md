# v19 在环运行摘要

- 程序：`/Users/ken/wm_bench/programs/world_model_target_delivery.py`
- `PROGRAM_VERSION`：`wm-memory-v19-20260921`
- 文件 SHA256：`45616ebd995acb2ce9240edcd0dba1ab3cc193bd1493bcc67c86bad202d35fa2`
- 日志：`attempt-1.json` / `attempt-1.log`

## 本轮改了什么

### 确认阶段移动实现

1. 单次采样移动请求改为 `20cm`。
   - 原 `15cm` 请求在弯道上实际直线位移出现 `0.1486m`，比 `CONFIRM_MIN_GAP_M=0.15m` 少 `1.4mm`，触发 `hit_duplicate_pose`。
2. 被判重复时沿同一方向继续移动 `10cm` 再采，不再反向。
   - 只有同方向 `follow_road` 返回 `0cm` / 无法移动时，才允许反向，并打印 `confirmation_direction_reversed`。
3. `hit_duplicate_pose` 现在打印与每个已有采样点的实际间距：
   - `nearest_gap_m`
   - `required_gap_m`
   - `distances_to_existing_m`

判定条件未改：`40~90cm`、3 次命中、不同位置、相邻间距 `>=0.15m`、同一轨迹。

### 接近阶段移动实现

1. `0.25m` 以外禁止直线 `forward`。
   - 改为单步 `follow_road(maxCm=10cm)`。
   - 每步后不 `observe`，只用 `odometry` + WorldModel 坐标重算距离。
2. 距离不再下降或 `<=0.25m` 时停下。
3. 停下后原地转向 WorldModel 目标方向，再 `approach(max_steps=1)` + `grab`。
4. `follow_road` 的实际 `distanceCm` 计入 `forward_after_last_observe_cm`。
5. 停止时仍 `>0.25m`：打印 `approach_min_distance_failed`，包含最小距离、当前距离、`roadId`、`onRoad`，然后失败，不离开道路追目标。
6. 记忆接近循环上限设为 `30` 步，避免不可控长跑。

原因：

- v16 诊断显示：采样 2→3 请求移动 `15cm`，弯道直线位移 `0.1486m < 0.15m`，差 `1.4mm` 被判重复。
- v13 诊断显示：直线 `forward 35cm` 在 `bailu-west-arc` 弯道偏出道路 `13.3cm`。
- 所以确认阶段需要更大请求步长和同向补采；接近阶段需要小步 `follow_road`。

## 本轮在环运行结果

`attempt-1`：

确认阶段完整通过：

```text
confirmation_sample hits=1 camera_distanceCm=44
confirmation_sample hits=2 camera_distanceCm=73  gap_to_previous_m=0.199
confirmation_sample hits=3 camera_distanceCm=87  gap_to_previous_m=0.200
memory_confirmed last_sample_wm_distance_m=0.87
```

接近阶段完整执行：

```text
approach_step wm_distance_m=0.775 follow_distanceCm=10 forward_after_last_observe_cm=10 onRoad=true
approach_step wm_distance_m=0.681 follow_distanceCm=10 forward_after_last_observe_cm=20 onRoad=true
approach_step wm_distance_m=0.588 follow_distanceCm=10 forward_after_last_observe_cm=30 onRoad=true
approach_step wm_distance_m=0.498 follow_distanceCm=10 forward_after_last_observe_cm=40 onRoad=true
approach_step wm_distance_m=0.498 follow_distanceCm=0  forward_after_last_observe_cm=40 onRoad=true
approach_memory_stop wm_distance_m=0.498 min_wm_distance_m=0.498 roadId=north-east-main onRoad=true
approach_min_distance_failed min_wm_distance_m=0.498 current_wm_distance_m=0.498 roadId=north-east-main required_m=0.25 onRoad=true
```

解释：

- 纯记忆行驶累计 `40cm`，满足 `>=30cm`。
- 全程 `onRoad=true`，没有离路。
- 沿道路能接近到的最小 WorldModel 距离是 `0.498m`，仍大于 `approach` 允许调用的 `0.25m`。
- 因此按规则失败，未调用 `approach()`，未 `grab()`。
- 该布局中球到道路中心/可行驶点的最小记忆距离约为 `0.498m`（`roadId=north-east-main`）。
