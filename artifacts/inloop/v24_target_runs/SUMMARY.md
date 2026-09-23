# v24 在环运行摘要（2026-09-23）

- 程序：`programs/world_model_target_delivery.py`，`PROGRAM_VERSION = wm-memory-v24-20260922`
- 文件 SHA256：`4beb6717dc8dd2db1a3e83aece003f324b1b3d32cecbb839f0ace6e3c33eecdb`
- 有效日志：`attempt-63.json` / `attempt-63.log`（map-03，与 v13/v19/v23 同一布局）
- 其余 `round*` 子目录是被跳过的布局、模拟器卡死或 follow_road 参数崩溃的记录，见文末。

## 对 v23 的评审结论（改动依据）

用真值（`artifacts/truth/R2-GYI-MVP-02/map-03.json`，8 units/m，起点 (-2.4865,-7.6757) heading π）
把 v23 日志的里程计位姿换算到世界系：`world = (-2.4865 - 8·x_odo, -7.6757 + 8·z_odo)`。

| 量 | 数值 |
|---|---|
| 摄像头测距 / 真实距离（三次确认样本） | 44/63、73/81、87/100 cm |
| WM 目标相对真球误差 | 13 cm（偏近） |
| v23 停车点到 WM 目标 / 真球 | 17.5 cm / 30.3 cm |
| 平台 grab 窗口（app.js measurePackageReach） | 正前方 4.75–16.9 cm，横向 ≤ 4.75 cm |
| approach(max_steps=1) 单次前进脉冲 | 0.1 s × 7.5 cm/s ≈ 0.75 cm |
| take_exit 一次扫过的距离 | 38.6 cm（stoppedBy=entered_road） |
| 真球锚点 | bailu-south 路 26.6 cm 处，距路口很近 |

v23 在 WM 距离 0.25 m 就停，真实还差 30 cm，两次单步 approach 只能各推 0.75 cm，失败是结构性的。
v23 报告里"take_exit 后继续 follow_road"和"连续两步增大才停"在该局都没有执行到（take_exit 后直接因 ≤0.25 m 跳出）。

## v24 改了什么

1. 记忆行驶（follow_road 10 cm 步）改为走到 WM 距离 ≤ 0.30 m 才退出（`APPROACH_FINE_DISTANCE_M`），
   不再在 0.25 m 就停；连续两步距离增大（`passed_nearest_point`）或近距离被挡停也会退出。
2. 退出后原地转向 WM 目标，再用 4 cm 直行盲步（`robot.forward`，不 observe）收到 WM 距离 ≤ 0.06 m
   （`MEMORY_STOP_DISTANCE_M`）；每步检查 onRoad、里程计实际位移、是否越过最近点。
   不能用 follow_road 细步：平台最小 10 cm（round1 因 5 cm 直接抛异常）；也不能沿路穿路口：
   take_exit 一次 38.6 cm 会撞上距路口 26.6 cm 的球。
3. approach(max_steps=1)+grab 最多 12 次（`APPROACH_MAX_CALLS`），用视觉精修最后几厘米；
   记录 approach 返回值；连续两次 reached 仍抓不到则停止。
4. 越过最近点停下且 WM 目标在车后方时不掉头（视觉偏近意味着真球更可能在前方）。
5. 日志新增：`approach_step` 带 pose/stoppedBy、`approach_endpoint_nudge_result`（里程计实测）、
   `approach_exit_move`、`approach_memory_stop.reason/pose`、`approach_turn_in_place`、
   `approach_fine_stop`、`approach_result`。

## attempt-63 关键数值

```text
approach_exit_move   roadId=bailu-west-arc exit_distanceCm=38.6 wm_distance_m=0.174 wm_bearing_deg=-54.9
approach_memory_stop reason=fine_phase wm_distance_m=0.174 pose=[-1.177,0.498,-30.5] onRoad=true
approach_turn_in_place start=-54.9 end=0 turnsDeg=[40,14.9]
approach_fine_stop   reason=within_memory_stop_distance steps=4cm×3 wm 0.135→0.095→0.055 roadId=bailu-south onRoad=true
approach_call 1..5   reached=false 每次；wm_distance 0.055→0.047→0.047→0.040→0.033
grab_attempt 5       holding=目标物
memory_navigation_metric passed=true forward_after_last_observe_cm=92.6 approach_calls=5 observe_count=6 onRoad=true
```

- 抓到球时 WM 距离 0.033 m。v25 同一路线的场景真值（record.samples，attempt-3 第 442 个样本）：车到球实际 16.2 cm，前向 16.1 cm、侧向 1.1 cm，在 grab 窗口（前向 4.75–16.9 cm）内；此前 4 次 grab 被平台记为 package_interaction_failed reason=far。
- 之后进入原有的送存放点流程（`anchor_attempt nw-bag` → `cross_road`），该局在 30 min 驱动超时前
  没有结束，未生成最终 record，task 得分 0。送货流程不在本轮改动范围。

## 环境问题（影响复现，不影响结论）

- `tools/inloop_driver.js` 修了三处：跳过布局后进程不退出（server.close 等 keep-alive）→ 清理后
  `process.exit`；临时目录删除与 Chrome 写缓存竞争 → rm 加重试；均为 bench 工具，平台文件未动。
- 复现 map-03 用 `--want-maps map-03` 反复注册（脚本见 SUMMARY 同目录的 round 记录），
  每次跳过约 1–2 s，不需要改平台 map pool。
- 22 日夜间机器上 assistantd/opendirectoryd 各占 50% CPU 时，headless Chrome 多次在登录或
  巡逻阶段冻结 10–30 min（round3/4/5）；负载降低并加 caffeinate 后正常。
