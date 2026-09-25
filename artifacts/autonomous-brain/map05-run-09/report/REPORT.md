# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v2`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-09/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: turn: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 77 |
| 大模型调用次数（含修复与传输重试） | 89 |
| 大模型累计耗时（秒） | 2320.642753 |
| 仿真用时（秒） | 354.560000 |
| 观测次数 | 393 |
| 动作判定失败数 | 13 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 1 |
| 失败轮数合计 | 14 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：17728；导出结束tick：17728。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_024 | 47.340000 | 73.680000 | 101.200000 | 202.060000 |
| guangyang-target-2 | target_049, target_098 | 86.280000 | 333.020000 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 3 | 2 | 0 | 0 | 1 | 74 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

评估方停止记录：Round 73 pick made a short alignment translation off the observed road, then refused grasp; current pick did not record a return path. Preserve the frozen run before correcting manipulation recovery.。
停止后NOT_RUNNING仅在已知停止记录、时间及末轮桥错误相符时单独分类；仍保留整局FAIL，不解释为自主完成。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **75**；平均误差 **5.662066 cm**；RMSE **6.679918 cm**。
无法计入的确认轨迹观测数：1；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 86, 'unmatched': 22}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 10 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":44,"frame_id":44,"tick":1763,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":37,"final_observation":45}} |
| 22 | {"action": "go_to", "params": {"object_id": "target_024"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":100,"frame_id":100,"tick":4062,"holding":false,"object_id":"target_024","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9211862068965517,"bbox":{"x":280.0,"y":208.0,"w":58.0,"h":50.0},"frame_id":"100","fed_to_world_model":true,"track_id":"target_024","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":45,"raw_bearing_deg":-1.52,"distance_cm":52.6355995957389…（完整内容见 evaluation.json） |
| 25 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":116,"frame_id":116,"tick":4774,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0,"elapsedTicks":0},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":1.6,"elapsedTicks":9},"recovery_steps":2,"before_observation":112,"final_observation":117}} |
| 28 | {"action": "go_to", "params": {"object_id": "storage-zone_033"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":158,"frame_id":158,"tick":7996,"holding":true,"object_id":"storage-zone_033","before_observation":130,"final_observation":159}} |
| 32 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":177,"frame_id":177,"tick":9003,"holding":true,"object_id":"storage-zone_005","before_observation":172,"final_observation":178}} |
| 37 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | action_failure | {"success":false,"reason":"visual_standoff_range_not_supported","evidence":{"after_observation":199,"frame_id":199,"tick":9826,"holding":true,"object_id":"storage-zone_005","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":183.0,"y":236.0,"w":1.0,"h":1.0},"frame_id":"199","fed_to_world_model":true,"track_id":"storage-zone_005","method":"visible-ground-region-bbox-centre","distance_cm":69.48251640451168,"bearing_deg":-16.93135817349978,"position_…（完整内容见 evaluation.json） |
| 40 | {"action": "explore", "params": {"exit_angle": -99}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":229,"frame_id":229,"tick":10715,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":8.7,"elapsedTicks":69},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.4,"elapsedTicks":74},"recovery_steps":1,"before_observation":226,"final_observation":230}} |
| 55 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":294,"frame_id":294,"tick":13685,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":64},"recovery_steps":2,"before_observation":290,"final_observation":295}} |
| 60 | {"action": "explore", "params": {"exit_angle": 90.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":317,"frame_id":317,"tick":15011,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":150},"recovery_steps":1,"before_observation":313,"final_observation":318}} |
| 64 | {"action": "explore", "params": {"exit_angle": 90.1}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":336,"frame_id":336,"tick":15831,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.1,"elapsedTicks":10},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.5,"elapsedTicks":67},"recovery_steps":1,"before_observation":332,"final_observation":337}} |
| 69 | {"action": "go_to", "params": {"object_id": "target_098"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":360,"frame_id":360,"tick":16813,"holding":false,"object_id":"target_098","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9139666666666666,"bbox":{"x":320.0,"y":208.0,"w":80.0,"h":60.0},"frame_id":"360","fed_to_world_model":false,"track_id":"target_098","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":34,"raw_bearing_deg":5.5,"distance_cm":41.5547962594026…（完整内容见 evaluation.json） |
| 73 | {"action": "pick", "params": {"object_id": "target_098"}} | action_failure | {"success":false,"reason":"visual_alignment_did_not_converge","evidence":{"after_observation":377,"frame_id":377,"tick":17272,"holding":false,"attempts":[],"detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9129245283018868,"bbox":{"x":268.0,"y":218.0,"w":106.0,"h":88.0},"frame_id":"377","fed_to_world_model":false,"track_id":"target_098","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":27,"raw_bearing_deg":0.14,"distance_cm":34.28456903267375,"bearing_deg":…（完整内容见 evaluation.json） |
| 75 | {"action": "go_to", "params": {"object_id": "target_098"}} | action_failure | {"success":false,"reason":"not_on_observed_road","evidence":{"after_observation":385,"frame_id":385,"tick":17500,"holding":false,"before_observation":385,"final_observation":386}} |
| 77 | {"action": "look_around", "params": {}} | external_stop | {"success":false,"reason":"turn: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/record.json.gz` — SHA256 `c06bfe10e7c754303f27fc2f9b6a07e555c51852d33fe3bb2768df5777171357`
- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/captures.json.gz` — SHA256 `d74c2535d8f42349080f86f260e7b5092bb9488e36f1d033a02eb8f3d5bdbf03`
- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/brain/summary.json` — SHA256 `80302620fbbabb2b25d027a535efea70abf53e929453f72bc9203e1560341479`
- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/brain/rounds.jsonl` — SHA256 `fa965c71be0d68ed0b01449a640e7c1812972d574071f3fe39cf2ef90e873446`
- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/brain/observations.jsonl` — SHA256 `b4505517665e1157111187c664cf0c3c775a0924fff51e5034be7b7a403119cf`
- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/brain/llm.jsonl` — SHA256 `4908c43c3c4d087f00f48cbc5b1e07b6c850604de51b796bb2dac5113196e21e`
- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `0bf5d95662e66a62f5866045cc1a0034703304c0f74b236954fb02d11497e51a`
- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/brain/motions.jsonl` — SHA256 `a44bf5c301252c1f592705265f6108a456c4a433b0ef7bc5720a037aa84e5be5`
- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/evaluation.json` — SHA256 `36b0409f2a7e3f7762ecd7011c06bd9a18bf9d8a02b2393ce435d31ff59efe3f`
- `artifacts/autonomous-brain/map05-run-09/map-05-run-1/evidence.json` — SHA256 `cc0d75e49da8cedebb39bc865d80f7e926f168b2913c1e8c24b35f92d1b035af`
- `artifacts/autonomous-brain/map05-run-09/manifest.json` — SHA256 `e4d02f1e1c98e0bc28ca887d7d9a9f28e2f8c3940685bc13153aa36b368a67a0`
- `artifacts/autonomous-brain/map05-run-09/summary.json` — SHA256 `a5c955eafa58c8ee893229617fc441102eda0687e316bfdff8e1b6d172e23a9a`
- `artifacts/autonomous-brain/map05-run-09/evaluator-stop.json` — SHA256 `2e8837478d53346815a700f29861422c9118226034adbc6701d2c4255eeb7f94`

评测器 SHA256：`168a19ac4f921f201d26d3afb7f293832f43d9a9817cbfe38b928acaa52a2308`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-09/map-05-run-1 --out <新的报告目录>`。
