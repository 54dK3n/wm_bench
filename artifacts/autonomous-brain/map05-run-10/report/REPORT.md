# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v2`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-10/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: take_exit: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 55 |
| 大模型调用次数（含修复与传输重试） | 58 |
| 大模型累计耗时（秒） | 1325.059109 |
| 仿真用时（秒） | 228.980000 |
| 观测次数 | 287 |
| 动作判定失败数 | 13 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 1 |
| 失败轮数合计 | 14 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：11449；导出结束tick：11449。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_024 | 47.340000 | 69.120000 | 89.920000 | 202.220000 |
| guangyang-target-2 | 未匹配 | 81.720000 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 2 | 2 | 0 | 0 | 0 | 53 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

评估方停止记录：Repeated take_exit commands stopped at front_clearance with zero distance before changing heading; a previous blocked 8.7cm move was mislabeled next_junction_observed because atNode stayed true. Preserve the frozen trial before correcting exit alignment and result precedence.。
停止后NOT_RUNNING仅在已知停止记录、时间及末轮桥错误相符时单独分类；仍保留整局FAIL，不解释为自主完成。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **30**；平均误差 **1.974752 cm**；RMSE **2.020529 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 45, 'unmatched': 52}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 10 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":44,"frame_id":44,"tick":1763,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":37,"final_observation":45}} |
| 21 | {"action": "go_to", "params": {"object_id": "target_024"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":94,"frame_id":94,"tick":3834,"holding":false,"object_id":"target_024","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9211862068965517,"bbox":{"x":280.0,"y":208.0,"w":58.0,"h":50.0},"frame_id":"94","fed_to_world_model":true,"track_id":"target_024","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":45,"raw_bearing_deg":-1.52,"distance_cm":52.6355995957389,"b…（完整内容见 evaluation.json） |
| 26 | {"action": "go_to", "params": {"object_id": "storage-zone_033"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":148,"frame_id":148,"tick":7297,"holding":true,"object_id":"storage-zone_033","before_observation":122,"final_observation":149}} |
| 30 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":167,"frame_id":167,"tick":8304,"holding":true,"object_id":"storage-zone_005","before_observation":162,"final_observation":168}} |
| 32 | {"action": "go_to", "params": {"object_id": "storage-zone_032"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":175,"frame_id":175,"tick":8532,"holding":true,"object_id":"storage-zone_032","before_observation":175,"final_observation":176}} |
| 38 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | action_failure | {"success":false,"reason":"visual_standoff_range_not_supported","evidence":{"after_observation":203,"frame_id":203,"tick":9583,"holding":true,"object_id":"storage-zone_005","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":183.0,"y":236.0,"w":1.0,"h":1.0},"frame_id":"203","fed_to_world_model":true,"track_id":"storage-zone_005","method":"visible-ground-region-bbox-centre","distance_cm":69.48251640451168,"bearing_deg":-16.93135817349978,"position_…（完整内容见 evaluation.json） |
| 44 | {"action": "explore", "params": {"exit_angle": -147.2}} | action_failure | {"success":false,"reason":"selected_exit_blocked","evidence":{"after_observation":243,"frame_id":243,"tick":10537,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0,"elapsedTicks":0},"before_observation":242,"final_observation":244}} |
| 46 | {"action": "explore", "params": {"exit_angle": -147.2}} | action_failure | {"success":false,"reason":"selected_exit_blocked","evidence":{"after_observation":252,"frame_id":252,"tick":10765,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0,"elapsedTicks":0},"before_observation":251,"final_observation":253}} |
| 47 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"selected_exit_blocked","evidence":{"after_observation":255,"frame_id":255,"tick":10765,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0,"elapsedTicks":0},"before_observation":254,"final_observation":256}} |
| 49 | {"action": "explore", "params": {"exit_angle": -147.2}} | action_failure | {"success":false,"reason":"selected_exit_blocked","evidence":{"after_observation":264,"frame_id":264,"tick":10993,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0,"elapsedTicks":0},"before_observation":263,"final_observation":265}} |
| 50 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"selected_exit_blocked","evidence":{"after_observation":267,"frame_id":267,"tick":10993,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0,"elapsedTicks":0},"before_observation":266,"final_observation":268}} |
| 52 | {"action": "explore", "params": {"exit_angle": -147.2}} | action_failure | {"success":false,"reason":"selected_exit_blocked","evidence":{"after_observation":276,"frame_id":276,"tick":11221,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0,"elapsedTicks":0},"before_observation":275,"final_observation":277}} |
| 53 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"selected_exit_blocked","evidence":{"after_observation":279,"frame_id":279,"tick":11221,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0,"elapsedTicks":0},"before_observation":278,"final_observation":280}} |
| 55 | {"action": "explore", "params": {"exit_angle": -147.2}} | external_stop | {"success":false,"reason":"take_exit: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/record.json.gz` — SHA256 `bf3fc7c438083de813c44aac4c87ae603a29d0cfa2802eac56de0db6b55116f0`
- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/captures.json.gz` — SHA256 `2c848aeefce883c8c9537481cf4f59dd7b269154fa23dff44cdf60432b18c6f9`
- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/brain/summary.json` — SHA256 `d165704c362387fd1c5d4f684c37a1e79cd4c0d3917dcc4acdf9f27c634439e6`
- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/brain/rounds.jsonl` — SHA256 `1706d3acf6b2d15c10ab1e87f86ef1c2765ff151b54243be715898bacf566b04`
- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/brain/observations.jsonl` — SHA256 `becfafa492391d167d75e80daa8388948cd52bb090ba84ab08585c0324027c3b`
- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/brain/llm.jsonl` — SHA256 `4138f89807305c8f582ddc35e65f9a5ff33669155b612d38001ebce04d022927`
- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `59f3f3e5c4132147678421e3dd5a038a25170629a5cdf772a692406021424f18`
- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/brain/motions.jsonl` — SHA256 `f421ee32b4b7af8b81e4cc421fc8e132a3594fdab649367b41379ee0792f3168`
- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/evaluation.json` — SHA256 `058b80735e23a7386295efe182d9e369c09f46600e7f297d7b56891e8ecf73f8`
- `artifacts/autonomous-brain/map05-run-10/map-05-run-1/evidence.json` — SHA256 `7f3692874a02d85545c64f0b6a95bbbe3f65875f42808676a0ca989fd62c431d`
- `artifacts/autonomous-brain/map05-run-10/manifest.json` — SHA256 `5523a6ac4f556b82adbe8e567c87fff777a1ca64c4043fc100593f0cf1499a5e`
- `artifacts/autonomous-brain/map05-run-10/summary.json` — SHA256 `ae9cf00c9358c5b2fd5dee8bb2ee77b6db21f8e277e65a23b0124f4aede93764`
- `artifacts/autonomous-brain/map05-run-10/evaluator-stop.json` — SHA256 `13610abd4f5750bebaf47667d4bb4436b4d1f8364d143d4a467706274ac7504b`

评测器 SHA256：`168a19ac4f921f201d26d3afb7f293832f43d9a9817cbfe38b928acaa52a2308`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-10/map-05-run-1 --out <新的报告目录>`。
