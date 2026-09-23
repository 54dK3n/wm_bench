# v23 在环运行摘要

- 程序：`/Users/ken/wm_bench/programs/world_model_target_delivery.py`
- `PROGRAM_VERSION`：`wm-memory-v23-20260921`
- 文件 SHA256：`199962a4ef19d90f773fb426f2bb8f75d0096f1844e1213769f82496295c3f8e`
- 日志：`attempt-1.json` / `attempt-1.log`

## 本轮改了什么

1. 修正接近阶段停止规则。
   - `follow_road` 返回 `0cm` 且 `frontClearanceCm` 充足时，不再判定“已到最近点”。
   - 使用一个 `2cm` 端点探步让平台进入节点范围，然后读取 `road_state.exits`。
   - 出口选择按 WorldModel 目标方位最接近的 `turnDeg`：

     `desiredExitTurnDeg = wrap_deg(-targetBearingDeg)`

     选 `abs(wrap_deg(exitTurnDeg - desiredExitTurnDeg))` 最小的出口。
   - `take_exit` 后继续 `follow_road` 单步 `10cm`，全程不 `observe`。
2. 只有连续 2 步“实际前进 `>=5cm` 但记忆距离增大”时，才判定已过最近点并停止。
3. 每次路口决策打印：
   - 当前 `roadId`
   - 所有可选出口 `roadId/direction/turnDeg`
   - WorldModel 目标方位
   - 选中的出口及理由
4. 若所有出口都会让距离增大，打印最小距离后失败。
5. 如果 `road_state.exits` 仍为空，使用公开 `map_graph()` 中通往任一 target 锚点的下一段路作为 fallback。

原因（来自日志的精确数值）：

- v20/`attempt-6` 与 v22 日志中，`north-east-main` 的 `follow_distanceCm=0` 时：
  - `roadProgressCm=91.3`
  - `atNode=false`
  - `atJunction=false`
  - `frontClearanceCm=184.2`
  - `exits=[]`
- 这不是最近点；第 4 步距离仍在下降：`0.588 -> 0.498m`。
- 一个 `2cm` 端点探步后，v23 日志显示平台给出真实出口：
  - `bailu-outer-arc`, `left`, `turnDeg=87.7`
  - `bailu-west-arc`, `right`, `turnDeg=-75.1`
  - `north-east-main`, `back`, `turnDeg=-180`
- 目标方位 `targetBearingDeg=29.7`，期望出口转角 `desiredExitTurnDeg=-29.7`。
- 选择 `bailu-west-arc`，转角误差 `45.4°`，是合法出口中最小。
- `take_exit` 成功，随后 `approach_memory_stop` 的 `roadId=bailu-west-arc`。

## 本轮运行结果

确认阶段：

```text
confirmation_sample hits=1 camera_distanceCm=44
confirmation_sample hits=2 camera_distanceCm=73  gap_to_previous_m=0.199
confirmation_sample hits=3 camera_distanceCm=87  gap_to_previous_m=0.200
memory_confirmed last_sample_wm_distance_m=0.87
```

接近阶段：

```text
approach_step wm_distance_m=0.775 follow_distanceCm=10 onRoad=true roadProgressCm=61.3
approach_step wm_distance_m=0.681 follow_distanceCm=10 onRoad=true roadProgressCm=71.3
approach_step wm_distance_m=0.588 follow_distanceCm=10 onRoad=true roadProgressCm=81.3
approach_step wm_distance_m=0.498 follow_distanceCm=10 onRoad=true roadProgressCm=91.3
approach_step wm_distance_m=0.498 follow_distanceCm=0  onRoad=true roadProgressCm=91.3
approach_endpoint_nudge roadProgressCm=91.3 atNode=false nudgeCm=2
approach_junction_decision targetBearingDeg=29.7 desiredExitTurnDeg=-29.7
  chosenRoadId=bailu-west-arc chosenTurnDeg=-75.1 chosenTurnErrorDeg=45.4
approach_memory_stop wm_distance_m=0.174 min_wm_distance_m=0.174
  roadId=bailu-west-arc onRoad=true
  forward_after_last_observe_cm=80.6
```

进入 `approach+grab`：

```text
approach_call count=1 max_steps=1 wm_distance_m=0.174
grab_attempt approach_call=1 holding=null
approach_call count=2 max_steps=1 wm_distance_m=0.167
grab_attempt approach_call=2 holding=null
memory_navigation_metric_failed reason=grab_failed
```

结论：

- 本轮验证要求已满足：在 `wm_distance_m=0.174m`、`<=0.25m` 时进入了 `approach(max_steps=1)+grab`。
- 纯记忆行驶累计 `80.6cm`，满足 `>=30cm`。
- 全程 `onRoad=true`，没有离路。
- 两次 `grab_attempt` 的 `holding=null`，说明本局没有抓到球；当前阻塞从“路口/离路”转移到了接近后的抓取效果，不再是路线问题。
