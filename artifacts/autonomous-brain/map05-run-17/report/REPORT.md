# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v3`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-17/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: turn: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 37 |
| 大模型调用次数（含修复与传输重试） | 43 |
| 大模型累计耗时（秒） | 895.006532 |
| 仿真用时（秒） | 205.620000 |
| 观测次数 | 250 |
| 动作判定失败数 | 7 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 1 |
| 失败轮数合计 | 8 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：10281；导出结束tick：10281。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_025, target_031 | 2.760000 | 75.480000 | 90.780000 | 188.400000 |
| guangyang-target-2 | 未匹配 | 41.280000 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 2 | 1 | 0 | 1 | 0 | 35 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

评估方停止记录：Round 33 released target_031 with empty holding but zero valid placement witnesses. It is RELEASED_UNVERIFIED; the frozen implementation can only mark delivery from HELD, excludes this lifecycle identity from reacquisition/retirement, and has no deferred verification/recovery path. Completion keeps it pending. Stop this failed trial and preserve native evidence before independent evaluation and repair. No claim of actual delivery is made from action output.。
停止后NOT_RUNNING仅在已知停止记录、时间及末轮桥错误相符时单独分类；仍保留整局FAIL，不解释为自主完成。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **21**；平均误差 **1.514426 cm**；RMSE **1.514426 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 48, 'unmatched': 36}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 9 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":48,"frame_id":48,"tick":1709,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":42,"final_observation":49}} |
| 23 | {"action": "go_to", "params": {"object_id": "storage-zone_027"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":167,"frame_id":167,"tick":7041,"holding":true,"object_id":"storage-zone_027","before_observation":141,"final_observation":168}} |
| 26 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":183,"frame_id":183,"tick":8241,"holding":true,"object_id":"storage-zone_007","before_observation":176,"final_observation":184}} |
| 28 | {"action": "go_to", "params": {"object_id": "storage-zone_053"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":188,"frame_id":188,"tick":8294,"holding":true,"object_id":"storage-zone_053","before_observation":188,"final_observation":189}} |
| 33 | {"action": "place", "params": {}} | action_failure | {"success":false,"reason":"released_ball_not_verified_in_storage","evidence":{"after_observation":230,"frame_id":230,"tick":9776,"holding":false,"place_trajectory":[{"method":"forward","params":{"distanceCm":7,"speed":30},"before":{"forwardCm":28.5,"rightCm":100.6,"headingDeg":-173.8,"distanceCm":1331.8,"tick":9248},"after":{"forwardCm":21.6,"rightCm":101.3,"headingDeg":-173.8,"distanceCm":1338.8,"tick":9286},"before_observation":211,"after_observation":212,"before_on_road":true,"after_on_road":…（完整内容见 evaluation.json） |
| 35 | {"action": "explore", "params": {"exit_angle": -99.8}} | action_failure | {"success":false,"reason":"road_blocked_at_junction","evidence":{"after_observation":244,"frame_id":244,"tick":10143,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":8.1,"elapsedTicks":72},"before_observation":242,"final_observation":245}} |
| 36 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_at_junction","evidence":{"after_observation":248,"frame_id":248,"tick":10281,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0,"elapsedTicks":46},"before_observation":246,"final_observation":249}} |
| 37 | {"action": "look_around", "params": {}} | external_stop | {"success":false,"reason":"turn: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/record.json.gz` — SHA256 `32b946f7c77d8d33f4a09967ec1fa21bec0bfb18975edb464fb03d7de5e7bfef`
- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/captures.json.gz` — SHA256 `5aa27b89e5f5ce787c4cc1bb0beba8d49069f92cb22df9e660829de755d52d60`
- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/brain/summary.json` — SHA256 `2e25bd98714f5c12c0ecc3f09e6ebe51f7270ad9b5a425479f896371802a163a`
- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/brain/rounds.jsonl` — SHA256 `df895b46208d01509b971374333b57715d63a2e6407bf2372829ea9e433ee482`
- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/brain/observations.jsonl` — SHA256 `2de7ef3c45f3b9402f21c690537a7f895107e83d258df205b3d0a378b36cbb62`
- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/brain/llm.jsonl` — SHA256 `b96026e9d93236af270508db70b95b1f8153698b3a749c5c97c15097774e69eb`
- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `1e4c4236444d2710b8acacbf19cead8cbabbb39816982ba56ed6e0927ae9909c`
- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/brain/motions.jsonl` — SHA256 `340c87c61c17acdf7f37fe9481aa88515f9d72d0a24b99778bfaf3c5385513b8`
- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/evaluation.json` — SHA256 `de235ec9d2cf0b111f821fb55988cdcd6027d78b451000c9b30e4869dd49876d`
- `artifacts/autonomous-brain/map05-run-17/map-05-run-1/evidence.json` — SHA256 `64712d9828b0116f0bf64905ba10cfca9323dad1cc08542c47e014fd1d1c3a4b`
- `artifacts/autonomous-brain/map05-run-17/manifest.json` — SHA256 `5934e20284cb6fcddeb547bb5f01f24c2d6b063742fe6c7f25b5a35ebe71791e`
- `artifacts/autonomous-brain/map05-run-17/summary.json` — SHA256 `b5954b702c1318262c3f0fab22e729c054b004dda4dcc771683ff1906291446c`
- `artifacts/autonomous-brain/map05-run-17/evaluator-stop.json` — SHA256 `1ef89898abc9a658bb7bdc784762a443b434517ccb49a4948ffcc94a1f045489`

评测器 SHA256：`f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-17/map-05-run-1 --out <新的报告目录>`。
