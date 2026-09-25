# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v2`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-07/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: turn: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 54 |
| 大模型调用次数（含修复与传输重试） | 57 |
| 大模型累计耗时（秒） | 1211.691688 |
| 仿真用时（秒） | 249.920000 |
| 观测次数 | 266 |
| 动作判定失败数 | 11 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 1 |
| 失败轮数合计 | 12 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：12496；导出结束tick：12496。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_023 | 44.220000 | 61.580000 | 72.940000 | 未能确定 |
| guangyang-target-2 | 未匹配 | 72.460000 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | True |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 0 | 0 | 53 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

评估方停止记录：Evaluator stopped after observed lateral road departure during round 48 visual standoff; subsequent explore calls reject off-road with no motion. Preserve failed trial before changing controller.。
停止后NOT_RUNNING仅在已知停止记录、时间及末轮桥错误相符时单独分类；仍保留整局FAIL，不解释为自主完成。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **17**；平均误差 **5.682209 cm**；RMSE **5.723675 cm**。
无法计入的确认轨迹观测数：1；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 22, 'unmatched': 10}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 9 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":39,"frame_id":39,"tick":1536,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":32,"final_observation":40}} |
| 21 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":118,"frame_id":118,"tick":6118,"holding":true,"object_id":"storage-zone_005","before_observation":95,"final_observation":119}} |
| 27 | {"action": "explore", "params": {"exit_angle": 90.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":142,"frame_id":142,"tick":7091,"holding":true,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":150},"recovery_steps":1,"before_observation":138,"final_observation":143}} |
| 29 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | action_failure | {"success":false,"reason":"route_no_progress","evidence":{"after_observation":158,"frame_id":158,"tick":8212,"holding":true,"object_id":"storage-zone_005","waypoint":[-0.156,0.865],"before_observation":148,"final_observation":159}} |
| 36 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":183,"frame_id":183,"tick":9248,"holding":true,"object_id":"storage-zone_005","before_observation":181,"final_observation":184}} |
| 42 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":212,"frame_id":212,"tick":10517,"holding":true,"object_id":"storage-zone_005","before_observation":203,"final_observation":213}} |
| 48 | {"action": "go_to", "params": {"object_id": "storage-zone_053"}} | action_failure | {"success":false,"reason":"visual_standoff_blocked","evidence":{"after_observation":250,"frame_id":250,"tick":12268,"holding":true,"object_id":"storage-zone_053","actuator_result":{"completed":true},"detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":128.0,"y":259.0,"w":429.0,"h":125.0},"frame_id":"250","fed_to_world_model":true,"track_id":"storage-zone_053","method":"visible-ground-region-bbox-centre","distance_cm":28.697686852962832,"bearing_deg…（完整内容见 evaluation.json） |
| 49 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"not_on_observed_road","evidence":{"after_observation":252,"frame_id":252,"tick":12268,"holding":true,"before_observation":252,"final_observation":253}} |
| 50 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"not_on_observed_road","evidence":{"after_observation":254,"frame_id":254,"tick":12268,"holding":true,"before_observation":254,"final_observation":255}} |
| 51 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"not_on_observed_road","evidence":{"after_observation":256,"frame_id":256,"tick":12268,"holding":true,"before_observation":256,"final_observation":257}} |
| 52 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"not_on_observed_road","evidence":{"after_observation":258,"frame_id":258,"tick":12268,"holding":true,"before_observation":258,"final_observation":259}} |
| 54 | {"action": "look_around", "params": {}} | external_stop | {"success":false,"reason":"turn: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/record.json.gz` — SHA256 `0ee06cf2f7103e75cc99461525c35450752c3ea08a34aff4b8adb6df1d99baad`
- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/captures.json.gz` — SHA256 `4b38a539e33b35cef899405dbfa1d8ba0e1b6ddee5cd257519d0603b0bc541db`
- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/brain/summary.json` — SHA256 `e30340d6e756c154e1c66432ede9342e8d9dccac251820daec9aa7aaf51a7ea7`
- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/brain/rounds.jsonl` — SHA256 `b08a3428737d2626e4b0ade46431572d2baf1495073eda31da71ec3319220faa`
- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/brain/observations.jsonl` — SHA256 `e5d8c0013baba299f845670e5b8c20c3d2e7b34a3c5336df86d8536efffd77d3`
- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/brain/llm.jsonl` — SHA256 `c61a6a55fcc1c6e55343c97e825ebf85a12739d996db1665ca305de7d441c690`
- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `b37f8cdc5b82b7cb65ec4e7870195625da08181ff4be9c7c70d4501dad44d903`
- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/brain/motions.jsonl` — SHA256 `2f1c56ec7a709d85c2a4427bed87b0bdc4836bf8711ab0cb8b1e8af2ad662b74`
- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/evaluation.json` — SHA256 `2f21cd7811944922aaf4a6dc3ee588096d71a760e2226dbdc5b38fb635006c3f`
- `artifacts/autonomous-brain/map05-run-07/map-05-run-1/evidence.json` — SHA256 `a1175663fc444174ef7550dc7e467db8b1cb82d7f86932fe2d8f546f2999f524`
- `artifacts/autonomous-brain/map05-run-07/manifest.json` — SHA256 `00a1a034ec6adad260e1a188713228644a166294081332dd5313477bf4fc7be6`
- `artifacts/autonomous-brain/map05-run-07/summary.json` — SHA256 `d7f092b2bd6b98010ba4d5f5e1abf49d93a5aff73d0a9e4f16f856f768136beb`
- `artifacts/autonomous-brain/map05-run-07/evaluator-stop.json` — SHA256 `bc2ba8e473e905ecb9268160079a58f2bab62faa1710c7217ace94eb01d6b390`

评测器 SHA256：`168a19ac4f921f201d26d3afb7f293832f43d9a9817cbfe38b928acaa52a2308`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-07/map-05-run-1 --out <新的报告目录>`。
