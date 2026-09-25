# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v2`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-08/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: turn: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 54 |
| 大模型调用次数（含修复与传输重试） | 64 |
| 大模型累计耗时（秒） | 1442.429385 |
| 仿真用时（秒） | 226.040000 |
| 观测次数 | 263 |
| 动作判定失败数 | 11 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 1 |
| 失败轮数合计 | 12 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：11302；导出结束tick：11302。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_021 | 47.340000 | 73.680000 | 90.780000 | 未能确定 |
| guangyang-target-2 | 未匹配 | 60.100000 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | True |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 2 | 1 | 0 | 0 | 1 | 52 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

评估方停止记录：place alignment exhausted combined turn/translation budget and left car off observed road; later navigation declined movement. Preserve trial before changing controller.。
停止后NOT_RUNNING仅在已知停止记录、时间及末轮桥错误相符时单独分类；仍保留整局FAIL，不解释为自主完成。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **28**；平均误差 **1.265561 cm**；RMSE **1.265561 cm**。
无法计入的确认轨迹观测数：1；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 27, 'unmatched': 18}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 10 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":44,"frame_id":44,"tick":1763,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":37,"final_observation":45}} |
| 22 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_range_not_supported","evidence":{"after_observation":97,"frame_id":97,"tick":3965,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9264117647058823,"bbox":{"x":292.0,"y":198.0,"w":40.0,"h":34.0},"frame_id":"97","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":63,"raw_bearing_deg":-1.1,"distance_cm":70.96864831142133,"bearin…（完整内容见 evaluation.json） |
| 24 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_range_not_supported","evidence":{"after_observation":103,"frame_id":103,"tick":4024,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.94,"bbox":{"x":292.0,"y":200.0,"w":38.0,"h":36.0},"frame_id":"103","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":66,"raw_bearing_deg":-1.24,"distance_cm":74.02842535359996,"bearing_deg":-1.…（完整内容见 evaluation.json） |
| 29 | {"action": "go_to", "params": {"object_id": "storage-zone_030"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":148,"frame_id":148,"tick":7346,"holding":true,"object_id":"storage-zone_030","before_observation":122,"final_observation":149}} |
| 39 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":198,"frame_id":198,"tick":9554,"holding":true,"object_id":"storage-zone_005","before_observation":190,"final_observation":199}} |
| 42 | {"action": "go_to", "params": {"object_id": "storage-zone_030"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":209,"frame_id":209,"tick":9849,"holding":true,"object_id":"storage-zone_030","before_observation":209,"final_observation":210}} |
| 47 | {"action": "place", "params": {}} | action_failure | {"success":false,"reason":"storage_alignment_did_not_converge","evidence":{"after_observation":241,"frame_id":241,"tick":10846,"holding":true,"before_observation":233,"final_observation":242}} |
| 49 | {"action": "go_to", "params": {"object_id": "storage-zone_053"}} | action_failure | {"success":false,"reason":"not_on_observed_road","evidence":{"after_observation":249,"frame_id":249,"tick":11074,"holding":true,"before_observation":249,"final_observation":250}} |
| 50 | {"action": "go_to", "params": {"object_id": "storage-zone_053"}} | action_failure | {"success":false,"reason":"not_on_observed_road","evidence":{"after_observation":251,"frame_id":251,"tick":11074,"holding":true,"before_observation":251,"final_observation":252}} |
| 52 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"not_on_observed_road","evidence":{"after_observation":259,"frame_id":259,"tick":11302,"holding":true,"before_observation":259,"final_observation":260}} |
| 53 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"not_on_observed_road","evidence":{"after_observation":261,"frame_id":261,"tick":11302,"holding":true,"before_observation":261,"final_observation":262}} |
| 54 | {"action": "look_around", "params": {}} | external_stop | {"success":false,"reason":"turn: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/record.json.gz` — SHA256 `27da33100d30df4f2a83d02cd85f5150b645d9105968655089374bdb1b7a0419`
- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/captures.json.gz` — SHA256 `b660fc673d1161388499e36e8056ff37b7f18daa11394b51bacb07a409374abd`
- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/brain/summary.json` — SHA256 `71ddbf63b2bc7b6dcd250d7dab194474905d12ff125a912553a4a126e450399e`
- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/brain/rounds.jsonl` — SHA256 `40fdcd2389e7add7dc2b2ded60b2fe2b068987276fe80914a0cf649a0429f4fa`
- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/brain/observations.jsonl` — SHA256 `cf09cb7627a008c7656a3817df3f27783b8dca654261f224bd3d7d34b15a3d9d`
- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/brain/llm.jsonl` — SHA256 `5dc647bfd5e2c161958a18c86a2d852c7a7271a9fb12b4dad55b7a15e3cf2e46`
- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `e959725090273d9e8a88f453f44d9f4f73ca83309b6b360cd0f19a74adaddfa0`
- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/brain/motions.jsonl` — SHA256 `7bac0b718be89a90cc730fd4aef0aabab76d6fa0e77ca0dd2cc221df4e9e3276`
- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/evaluation.json` — SHA256 `c7b954ac14c50e60076293866a2b812afecfd4c70d3a30333a679abd1024eba5`
- `artifacts/autonomous-brain/map05-run-08/map-05-run-1/evidence.json` — SHA256 `432fb68cff52192c832fb8fdf4defae4cbf6c498b9ceb45b063f358401ebb5d0`
- `artifacts/autonomous-brain/map05-run-08/manifest.json` — SHA256 `5afaf976ad97a3cd2a06dd9adc8ba14c6a7ed8ea04ee36fcb24d19a7636bdea2`
- `artifacts/autonomous-brain/map05-run-08/summary.json` — SHA256 `e32a624c68ac1edb8bedafbf9727528aaf9a2305e6ac714ef89f8a2faee70b82`
- `artifacts/autonomous-brain/map05-run-08/evaluator-stop.json` — SHA256 `1b51dc9a1cdc83c7c80815b379e97385db27337f0ed6ee3fa614d0c3088802d2`

评测器 SHA256：`168a19ac4f921f201d26d3afb7f293832f43d9a9817cbfe38b928acaa52a2308`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-08/map-05-run-1 --out <新的报告目录>`。
