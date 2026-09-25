# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v3`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-15/map-05-run-1`。大脑状态：`failed`；原因：LLMRequestError: LLM request failed: URLError; see transcript。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 69 |
| 大模型调用次数（含修复与传输重试） | 84 |
| 大模型累计耗时（秒） | 2915.470196 |
| 仿真用时（秒） | 353.480000 |
| 观测次数 | 442 |
| 动作判定失败数 | 13 |
| 执行或模型错误数 | 1 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 14 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：17674；导出结束tick：17674。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_021, target_107 | 2.760000 | 49.460000 | 86.020000 | 186.820000 |
| guangyang-target-2 | 未匹配 | 296.880000 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 2 | 2 | 0 | 0 | 0 | 67 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **56**；平均误差 **8.839469 cm**；RMSE **9.137277 cm**。
无法计入的确认轨迹观测数：2；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 69, 'unmatched': 22}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 8 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":46,"frame_id":46,"tick":1709,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":38,"final_observation":47}} |
| 13 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":78,"frame_id":78,"tick":2631,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8878541374474053,"bbox":{"x":220.0,"y":204.0,"w":62.0,"h":46.0},"frame_id":"78","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":43,"raw_bearing_deg":-9.42,"distance_cm":51.11990959564657,"…（完整内容见 evaluation.json） |
| 15 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":87,"frame_id":87,"tick":2920,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8955900621118013,"bbox":{"x":294.0,"y":204.0,"w":56.0,"h":46.0},"frame_id":"87","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":46,"raw_bearing_deg":0.28,"distance_cm":53.640303916514654,"…（完整内容见 evaluation.json） |
| 17 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":99,"frame_id":99,"tick":3152,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8955900621118013,"bbox":{"x":294.0,"y":204.0,"w":56.0,"h":46.0},"frame_id":"99","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":46,"raw_bearing_deg":0.28,"distance_cm":53.640303916514654,"…（完整内容见 evaluation.json） |
| 20 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":111,"frame_id":111,"tick":3700,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8991090629800307,"bbox":{"x":306.0,"y":204.0,"w":62.0,"h":42.0},"frame_id":"111","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":42,"raw_bearing_deg":2.34,"distance_cm":49.59685461217076…（完整内容见 evaluation.json） |
| 24 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":160,"frame_id":160,"tick":6753,"holding":true,"object_id":"storage-zone_007","before_observation":135,"final_observation":161}} |
| 28 | {"action": "go_to", "params": {"object_id": "storage-zone_019"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":186,"frame_id":186,"tick":8185,"holding":true,"object_id":"storage-zone_019","before_observation":179,"final_observation":187}} |
| 30 | {"action": "go_to", "params": {"object_id": "storage-zone_057"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":198,"frame_id":198,"tick":8417,"holding":true,"object_id":"storage-zone_057","before_observation":198,"final_observation":199}} |
| 35 | {"action": "explore", "params": {"exit_angle": -99}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":242,"frame_id":242,"tick":10020,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":8.7,"elapsedTicks":74},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.4,"elapsedTicks":74},"recovery_steps":1,"before_observation":238,"final_observation":243}} |
| 42 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":289,"frame_id":289,"tick":11341,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0.6,"elapsedTicks":2},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":10,"elapsedTicks":58},"recovery_steps":1,"before_observation":286,"final_observation":290}} |
| 48 | {"action": "explore", "params": {"exit_angle": 22.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":326,"frame_id":326,"tick":13049,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.1,"elapsedTicks":10},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.5,"elapsedTicks":73},"recovery_steps":1,"before_observation":321,"final_observation":327}} |
| 49 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":333,"frame_id":333,"tick":13600,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.1,"elapsedTicks":10},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.5,"elapsedTicks":73},"recovery_steps":1,"before_observation":328,"final_observation":334}} |
| 59 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":390,"frame_id":390,"tick":15788,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":64},"recovery_steps":2,"before_observation":386,"final_observation":391}} |
| 69 | null | execution_error | {"success":false,"reason":"LLM request failed: URLError; see transcript","error_type":"LLMRequestError"} |

失败判定项：no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/record.json.gz` — SHA256 `7f90184ea831d8288599c927aa6a896da71e54669cdc354ade6319ea99e1acff`
- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/captures.json.gz` — SHA256 `1830b13533ca78a73c845be641de12c26c3fd7710366c2828ad25355c6173483`
- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/brain/summary.json` — SHA256 `7afff7988e15b52d298f540884542b6bfa1ce8c13dfcaffddd335664681f91ae`
- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/brain/rounds.jsonl` — SHA256 `59a513b7b3f20dc3bd81c4fa1ecd7a88a5ec0a30cd315318d1d65a692f7e73c6`
- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/brain/observations.jsonl` — SHA256 `1bd943dab13acfaf70c259dd73b4afc324f42902a47b2ac68517e161a70ab3bd`
- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/brain/llm.jsonl` — SHA256 `434f2a157eefd71bdb2e164ff6c0745fbb5ca9d7da4d230967950c3060ac68a3`
- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `e361b7bbfb9d3edebef758093191b0a0cb5bf880ba125dbe0c4b625311e1d7fb`
- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/brain/motions.jsonl` — SHA256 `8a82eda510e3e57fd5fef177364e4b8dc5e92978d26f0b8bbc890a0981801492`
- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/evaluation.json` — SHA256 `74e9396f73ee80bf2a04e497086f0b1f6fa3e6763c19b69ba0e48fa7c12b7d73`
- `artifacts/autonomous-brain/map05-run-15/map-05-run-1/evidence.json` — SHA256 `63197fc3583241209b43970f592ac487820f758ec3cdecf248100cba7345b4c3`
- `artifacts/autonomous-brain/map05-run-15/manifest.json` — SHA256 `e4d541e3022a0be2530ed3897d1513057d10f606d889cdea131fae9ffcfb2ad4`
- `artifacts/autonomous-brain/map05-run-15/summary.json` — SHA256 `7e11a8d8fdb99f64d4680fae918a4b604775d7b7007a57740988c675784a71bd`

评测器 SHA256：`f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-15/map-05-run-1 --out <新的报告目录>`。
