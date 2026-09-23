# v25 在环运行摘要（2026-09-23，送货闭环）

- 程序：`programs/world_model_target_delivery.py`，`PROGRAM_VERSION = wm-memory-v25-20260923`
- 相对 v24 只加日志：送货阶段每次 follow_road / take_exit / 2cm 探步打印 roadId、请求距离、
  实际距离、stoppedBy、里程计 pose、road_state（roadProgressCm/atNode/nodeId/frontClearanceCm）。
  由 `DELIVERY_LOG["on"]` 控制，在抓到球之后才打开；确认与接近阶段一行未改（输出逐行与 v24 attempt-63 相同）。
- 有效日志：`attempt-3.json`（map-03）、`attempt-3.samples.json`（728 个场景真值样本）、`attempt-3.log`。
- 文件 SHA256 见 `program.sha256`。

## 结果（验收通过）

```text
runState=运行已结束  wallSeconds=78.1  stallReason=None  timedOut=False
score total=43.1  task=3.1/40  rule=25/25  auto=15/15  mission=1/13
record.events: package_grabbed guangyang-target-2 t=38040
               package_released  position=[-9.859,-7.772] t=63680
               package_delivered guangyang-target-2 deliveryId=delivery-target-storage t=63680
flow_end success=true one_target_released=true
```

- 验收条件满足：record.events 含 guangyang-target-2 的 `package_delivered`；mission 1/13。
- `#pythonFeedback` 全程 hidden，没有真正的 Python 反馈（v24 里记录的"Python 代码有问题"是静态标题）。

## v24 attempt-63 卡死的定性

- v25 只加日志就走通，送货段仿真用时 25.6 s（t=38.0→63.7 s），说明 v24 那局从
  `GY_STAGE cross_road north-east-main` 起 30 min 无输出不是程序逻辑问题，而是模拟器冻结
  （同一夜 round3/4/5 在登录/巡逻阶段也出现过同类冻结，均在机器高负载时段）。
- 驱动新增的 sim_frozen / program_stalled 判定本局未触发；下次再冻结时会在 120 s 内退出并保存
  `session.recorder.record` 的 events/samples。

## 送货段路线与位姿（对照 success_runs/attempt-4）

attempt-4（`minimal_target2_flow.py`）只打了 GY_STAGE 阶段行，没有 pose/roadProgress，
所以只能对照路线顺序；两局顺序一致：bailu-west-arc → north-east-main → north-west-main → nw-bag。
v25 新增的位姿数据：

```text
delivery_phase_start   bailu-south progress=11.0 atNode=true node=bailu-south:start
take_exit bailu-west-arc  40.1cm entered_road  → progress=6.3  node=bailu-outer-arc:start
follow bailu-west-arc     6.3cm junction        → progress=0
take_exit north-east-main 25.0cm entered_road  → progress=81.9 pose=[-0.819,0.274,-90]
follow north-east-main    66.4cm junction       → progress=15.6 node=central-north:start
take_exit north-west-main 40.6cm entered_road  → progress=63.1
follow north-west-main    47.5cm junction       → progress=15.6 node=north-west-main:start
take_exit nw-bag          40.6cm entered_road  → progress=19.4
follow nw-bag (anchor)    15.0cm max_distance   → progress=4.4  node=nw-bag:start
release_sample follow     24.4cm junction  → release accepted → package_delivered
```

## grab 瞬间的真实距离（替换 v24 摘要里"约 16 cm"的推算）

record.samples 第 442 个样本（tick 1902，holding 变为 guangyang-target-2 的前一帧）：
车 (8.061, -3.584, heading -100.7°)，球 (9.3127, -3.2587)。

```text
distance = 16.2 cm   forward = 16.1 cm   side = 1.1 cm
grab 窗口：forward 4.75–16.9 cm，|side| <= 4.75 cm
```

此前 4 次 grab 在 record.events 里均为 `package_interaction_failed reason=far`，与逐次 0.75 cm 的
approach 脉冲逼近过程一致。

## 驱动改动（bench 工具，平台文件未动）

- 只在 `#pythonFeedback` 非 hidden 时记录 `pythonFeedback{message}`；`feedbackText` 不再取静态标题。
- 每 30 s 记录 `timeline`：tick、车辆真值位姿、holding、包裹真值位置、输出长度。
- tick 连续 120 s 不变 → `stallReason=sim_frozen`；tick 前进但 120 s 无新输出 → `program_stalled`；
  两者都会点击"停止"让平台提交 record 后退出。页面 120 s 无响应也按 sim_frozen 处理。
- 保存完整 `record.events`，samples 写到 `<out>.samples.json`；无最终 record 时回退到
  `competitionSession.recorder.record`。
- 已知小问题：运行中 `recorder.record.samples/events` 计数读为 null（timeline 里 samples=None），
  只影响时间线展示，tick 与位姿正常。
