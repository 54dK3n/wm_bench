# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v4`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1`。大脑状态：`failed`；原因：round_limit。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 140 |
| 大模型调用次数（含修复与传输重试） | 150 |
| 大模型累计耗时（秒） | 2268.684464 |
| 仿真用时（秒） | 669.500000 |
| 观测次数 | 929 |
| 动作判定失败数 | 19 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 19 |

上限：140 轮 / 1200 秒；达到上限判失败。
最终样本tick：33475；导出结束tick：33475。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_021, target_034, target_116 | 2.760000 | 67.940000 | 95.200000 | 206.580000 |
| guangyang-target-2 | target_102, target_112, target_136 | 45.920000 | 570.100000 | 590.380000 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | False | False | True |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 4 | 4 | 0 | 0 | 0 | 136 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **75**；平均误差 **5.832529 cm**；RMSE **7.033870 cm**。
无法计入的确认轨迹观测数：3；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 188, 'unmatched': 82}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 8 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":46,"frame_id":46,"tick":1709,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":38,"final_observation":47}} |
| 18 | {"action": "go_to", "params": {"object_id": "target_034"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":119,"frame_id":119,"tick":3981,"holding":false,"object_id":"target_034","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8880745341614906,"bbox":{"x":296.0,"y":204.0,"w":56.0,"h":46.0},"frame_id":"119","fed_to_world_model":true,"track_id":"target_034","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":46,"raw_bearing_deg":0.55,"distance_cm":53.64174438237099…（完整内容见 evaluation.json） |
| 23 | {"action": "go_to", "params": {"object_id": "storage-zone_019"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":170,"frame_id":170,"tick":7039,"holding":true,"object_id":"storage-zone_019","before_observation":147,"final_observation":171}} |
| 28 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":200,"frame_id":200,"tick":8577,"holding":true,"object_id":"storage-zone_007","before_observation":192,"final_observation":201}} |
| 33 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":226,"frame_id":226,"tick":9437,"holding":true,"object_id":"storage-zone_007","before_observation":225,"final_observation":227}} |
| 34 | {"action": "go_to", "params": {"object_id": "storage-zone_019"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":228,"frame_id":228,"tick":9437,"holding":true,"object_id":"storage-zone_019","before_observation":228,"final_observation":229}} |
| 41 | {"action": "explore", "params": {"exit_angle": -56.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":274,"frame_id":274,"tick":10902,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":39.9,"elapsedTicks":213},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":9.4,"elapsedTicks":56},"recovery_steps":1,"before_observation":270,"final_observation":275}} |
| 65 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":423,"frame_id":423,"tick":15898,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.8,"elapsedTicks":9},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.2,"elapsedTicks":69},"recovery_steps":5,"before_observation":416,"final_observation":424}} |
| 86 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":556,"frame_id":556,"tick":20029,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":5.6,"elapsedTicks":18},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":15,"elapsedTicks":83},"recovery_steps":2,"before_observation":552,"final_observation":557}} |
| 103 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":677,"frame_id":677,"tick":24140,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":64},"recovery_steps":2,"before_observation":673,"final_observation":678}} |
| 110 | {"action": "explore", "params": {"exit_angle": 90.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":717,"frame_id":717,"tick":26024,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":92},"recovery_steps":1,"before_observation":712,"final_observation":718}} |
| 111 | {"action": "explore", "params": {"exit_angle": -180}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":724,"frame_id":724,"tick":26610,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":92},"recovery_steps":1,"before_observation":719,"final_observation":725}} |
| 122 | {"action": "go_to", "params": {"object_id": "target_136"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":790,"frame_id":790,"tick":28685,"holding":false,"object_id":"target_136","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9237037037037037,"bbox":{"x":288.0,"y":208.0,"w":78.0,"h":54.0},"frame_id":"790","fed_to_world_model":false,"track_id":"target_136","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":35,"raw_bearing_deg":0.96,"distance_cm":42.438469559910…（完整内容见 evaluation.json） |
| 125 | {"action": "pick", "params": {"object_id": "target_136"}} | action_failure | {"success":false,"reason":"three_grab_attempts_failed","evidence":{"after_observation":806,"frame_id":806,"tick":29150,"holding":false,"object_id":"target_136","attempts":[{"attempt":1,"before_observation":801,"after_observation":802,"holding":false,"alignment":{"mode":"camera_bearing+confirmed_position_odometry","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9115225976305397,"bbox":{"x":268.0,"y":218.0,"w":106.0,"h":86.0},"frame_id":"801","fed_to_world_model":false,"tra…（完整内容见 evaluation.json） |
| 129 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"route_no_progress","evidence":{"after_observation":844,"frame_id":844,"tick":30536,"holding":true,"object_id":"storage-zone_007","waypoint":[-0.156,0.865],"before_observation":831,"final_observation":845}} |
| 130 | {"action": "go_to", "params": {"object_id": "storage-zone_019"}} | action_failure | {"success":false,"reason":"route_blocked","evidence":{"after_observation":859,"frame_id":859,"tick":31818,"holding":true,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":40.6,"elapsedTicks":214},"before_observation":846,"final_observation":860}} |
| 135 | {"action": "go_to", "params": {"object_id": "storage-zone_070"}} | action_failure | {"success":false,"reason":"visual_standoff_target_not_observed","evidence":{"after_observation":895,"frame_id":895,"tick":32866,"holding":true,"object_id":"storage-zone_070","detection":null,"before_observation":893,"final_observation":896}} |
| 137 | {"action": "go_to", "params": {"object_id": "storage-zone_144"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":911,"frame_id":911,"tick":33191,"holding":true,"object_id":"storage-zone_144","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":304.0,"y":251.0,"w":1.0,"h":1.0},"frame_id":"911","fed_to_world_model":true,"track_id":"storage-zone_144","method":"visible-ground-region-bbox-centre","distance_cm":53.151718974474804,"bearing_deg":-1.9459214718044362,"p…（完整内容见 evaluation.json） |
| 138 | {"action": "go_to", "params": {"object_id": "storage-zone_070"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":913,"frame_id":913,"tick":33191,"holding":true,"object_id":"storage-zone_070","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":286.0,"y":254.0,"w":1.0,"h":1.0},"frame_id":"913","fed_to_world_model":true,"track_id":"storage-zone_070","method":"visible-ground-region-bbox-centre","distance_cm":51.24685396809029,"bearing_deg":-4.185492435104798,"pos…（完整内容见 evaluation.json） |

失败判定项：no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；round_limit_reached；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/record.json.gz` — SHA256 `617689e51ad4e76a64b16cc718ff08c7b0051c7a6a9b6f3b9f942f6f3c311ac6`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/captures.json.gz` — SHA256 `a0e3a56229d42f9757dde6963f0c169c7f279f406b326a4ee801d5747a8e50c7`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/brain/summary.json` — SHA256 `a6a96d252c6403a9eeadb4182f86981c703ebc054f3593377994823c3d976ffb`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/brain/rounds.jsonl` — SHA256 `98aa5eb4d612d6f510d7ff16f19f3e1aa42cac81d02c9414fe2dbac6109f3356`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/brain/observations.jsonl` — SHA256 `76e951da0d459cf070d77ba65a33a82dd0bc8720d7365825aa8b2c7338166043`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/brain/llm.jsonl` — SHA256 `a60dfc1c3d01c13bf66c62ea0a98efc2a2d44408d3a441ae18cbc4c631574ce4`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `d78e40c72b94a50c92136de09370326cd8efae157ab4211b958ec81b4284880f`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/brain/motions.jsonl` — SHA256 `afd7d850318345237ada6a2d59b5c05c79f93220bd3ddb7e6e6003ff2a85f64c`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/evaluation.json` — SHA256 `428eb51c6f3dc4a49e251ca0d2c55fdc8ad29d4aef3490cb62e1989dfad51001`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1/evidence.json` — SHA256 `cdbf8bb18c744ec365fa705b55be9aa195a8b8ddd61c96276f8c9f098b96f96c`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/manifest.json` — SHA256 `5603097545471a281672a25152be8c654d7f7b29e658c79fc5d82e32f9c3d55f`
- `artifacts/autonomous-brain/unobserved-junction-replay-01/summary.json` — SHA256 `d2befb44a40a619c4f5500ed04376be9afa4a63ad96850b3840cd5ade8b9f904`

评测器 SHA256：`69e4f719afb536af72b55feb0c42835106c633c0491d4725fd9ed549965dccd7`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/unobserved-junction-replay-01/map-05-run-1 --out <新的报告目录>`。
