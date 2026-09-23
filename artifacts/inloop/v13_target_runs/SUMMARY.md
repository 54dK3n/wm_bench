# v13 在环运行摘要

- 程序：`/Users/ken/wm_bench/programs/world_model_target_delivery.py`
- `PROGRAM_VERSION`：`wm-memory-v13-20260921`
- 文件 SHA256：`043a1df21fad72e9614200cfcfa2da44a81c2144dde233fea2c9b0d50170eda8`
- 日志：`attempt-1.json` / `attempt-1.log`

## 确认阶段

确认阶段按新要求完成：

| 项 | 结果 |
|---|---|
| 命中次数 | 3 |
| 相机距离 | 44 / 73 / 87 cm |
| 3 个位置 | 均不同 |
| 相邻采样间距 | 0.199 m / 0.150 m |
| 最后采样点 WorldModel 距离 | 0.87 m |
| 采样移动 | 全部为 `follow_road`，未使用朝目标直线 `forward/backward` |
| 每次移动后 onRoad | true |
| 确认完成时 observe 次数 | 6 |

确认日志片段：

```text
confirmation_sample hits=1 camera_distanceCm=44
confirmation_sample_move direction=away distanceCm=20 onRoad=true
confirmation_sample hits=2 camera_distanceCm=73
confirmation_sample_move direction=away distanceCm=15 onRoad=true
confirmation_sample hits=3 camera_distanceCm=87
memory_confirmed last_sample_wm_distance_m=0.87
```

## 接近阶段

确认后 `approach_step` 起始：

```text
wm_distance_m=0.87, wm_bearing_deg=-3.3, onRoad=true
```

第一步纯记忆 forward 35 cm 后触发 onRoad=false：

```json
{"event":"approach_on_road_violation","stage":"forward","roadId":"bailu-west-arc","onRoad":false,"lateralOffsetCm":-13.3}
```

按 e) 要求，程序没有继续 approach/grab，在本局安全失败。

## 结论

- a–d 与新的确认阶段移动约束已按本轮要求实现并留下可核对日志。
- e) 生效，但当前接近阶段的一次 35 cm 直线 forward 仍会在弯道离开道路。
- 下一处需改的是接近阶段的运动方式：保留 WorldModel 坐标 + 里程计，但减小直进行程并用 road_state 持续回正，或改为沿道路 `follow_road`，才能同时满足 e) 与“记忆导航”指标。
