# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v4`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-19/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: turn: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 163 |
| 大模型调用次数（含修复与传输重试） | 173 |
| 大模型累计耗时（秒） | 2679.616399 |
| 仿真用时（秒） | 691.660000 |
| 观测次数 | 1022 |
| 动作判定失败数 | 26 |
| 执行或模型错误数 | 1 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 27 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：34583；导出结束tick：34583。
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
| 4 | 4 | 0 | 0 | 0 | 159 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

评估方停止记录：Repeated next_junction_observed success contradicted by unchanged odometry and fresh atNode=false/exits=[]; stop for a versioned observation-Judge and boundary-recovery fix.。
停止后NOT_RUNNING仅在已知停止记录、时间及末轮桥错误相符时单独分类；仍保留整局FAIL，不解释为自主完成。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **75**；平均误差 **5.832529 cm**；RMSE **7.033870 cm**。
无法计入的确认轨迹观测数：3；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 254, 'unmatched': 81}。
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
| 142 | {"action": "go_to", "params": {"object_id": "storage-zone_144"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":938,"frame_id":938,"tick":33655,"holding":true,"object_id":"storage-zone_144","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":304.0,"y":251.0,"w":1.0,"h":1.0},"frame_id":"938","fed_to_world_model":true,"track_id":"storage-zone_144","method":"visible-ground-region-bbox-centre","distance_cm":53.151718974474804,"bearing_deg":-1.9459214718044362,"p…（完整内容见 evaluation.json） |
| 143 | {"action": "go_to", "params": {"object_id": "storage-zone_144"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":940,"frame_id":940,"tick":33655,"holding":true,"object_id":"storage-zone_144","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":304.0,"y":251.0,"w":1.0,"h":1.0},"frame_id":"940","fed_to_world_model":true,"track_id":"storage-zone_144","method":"visible-ground-region-bbox-centre","distance_cm":53.151718974474804,"bearing_deg":-1.9459214718044362,"p…（完整内容见 evaluation.json） |
| 148 | {"action": "go_to", "params": {"object_id": "storage-zone_144"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":961,"frame_id":961,"tick":33887,"holding":true,"object_id":"storage-zone_144","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":304.0,"y":251.0,"w":1.0,"h":1.0},"frame_id":"961","fed_to_world_model":true,"track_id":"storage-zone_144","method":"visible-ground-region-bbox-centre","distance_cm":53.151718974474804,"bearing_deg":-1.9459214718044362,"p…（完整内容见 evaluation.json） |
| 152 | {"action": "go_to", "params": {"object_id": "storage-zone_144"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":979,"frame_id":979,"tick":34119,"holding":true,"object_id":"storage-zone_144","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":304.0,"y":251.0,"w":1.0,"h":1.0},"frame_id":"979","fed_to_world_model":true,"track_id":"storage-zone_144","method":"visible-ground-region-bbox-centre","distance_cm":53.151718974474804,"bearing_deg":-1.9459214718044362,"p…（完整内容见 evaluation.json） |
| 155 | {"action": "go_to", "params": {"object_id": "storage-zone_144"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":994,"frame_id":994,"tick":34351,"holding":true,"object_id":"storage-zone_144","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":304.0,"y":251.0,"w":1.0,"h":1.0},"frame_id":"994","fed_to_world_model":true,"track_id":"storage-zone_144","method":"visible-ground-region-bbox-centre","distance_cm":53.151718974474804,"bearing_deg":-1.9459214718044362,"p…（完整内容见 evaluation.json） |
| 158 | {"action": "go_to", "params": {"object_id": "storage-zone_144"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":1002,"frame_id":1002,"tick":34351,"holding":true,"object_id":"storage-zone_144","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":304.0,"y":251.0,"w":1.0,"h":1.0},"frame_id":"1002","fed_to_world_model":true,"track_id":"storage-zone_144","method":"visible-ground-region-bbox-centre","distance_cm":53.151718974474804,"bearing_deg":-1.9459214718044362…（完整内容见 evaluation.json） |
| 161 | {"action": "go_to", "params": {"object_id": "storage-zone_144"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":1017,"frame_id":1017,"tick":34583,"holding":true,"object_id":"storage-zone_144","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":304.0,"y":251.0,"w":1.0,"h":1.0},"frame_id":"1017","fed_to_world_model":true,"track_id":"storage-zone_144","method":"visible-ground-region-bbox-centre","distance_cm":53.151718974474804,"bearing_deg":-1.9459214718044362…（完整内容见 evaluation.json） |
| 163 | {"action": "look_around", "params": {}} | execution_error | {"success":false,"reason":"turn: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/record.json.gz` — SHA256 `7119fb382ae5d3f7dbbf1457193470ffeca99ed5103111699f6425de20616591`
- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/captures.json.gz` — SHA256 `39f6b5a80a269238e18c45e379283ec4fd02d5d748575d43ad4aa2aa0febce0d`
- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/brain/summary.json` — SHA256 `7a33f0466c4661c17927877e8cb2b9c0db457976b838ccb00c21d9a880df852f`
- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/brain/rounds.jsonl` — SHA256 `0c1080cf7d9af162ed37846cd7776d36ae6dcfb5f6024fd8aef33b404b160c7b`
- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/brain/observations.jsonl` — SHA256 `21fe49b8864498e717dd56b0e7a576956405d785049024a78360e03505a62cf1`
- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/brain/llm.jsonl` — SHA256 `a7783e92cfaed9ebc37847080bcf3409022c3226016a36208a3823b87c80e989`
- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `78cee2eafb13818c240a6c473e25709152ae547df0067b02f04f33e9e23dc0c2`
- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/brain/motions.jsonl` — SHA256 `4f51d1a2aede1ae6bddb278cdc75a3b094552925782d00cd589eaa04e049b38f`
- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/evaluation.json` — SHA256 `5c1dbc2b3b10873cf87fd68bb2362875797d6b6675a537aad736c311cca1a485`
- `artifacts/autonomous-brain/map05-run-19/map-05-run-1/evidence.json` — SHA256 `9b3cb4ec7b269dc65c4060efada09fabb44fb43732898996f2b6650866167846`
- `artifacts/autonomous-brain/map05-run-19/manifest.json` — SHA256 `69ccefcef37c1aed294f87d554ede3e5f4ae9be4d8f16b7db1eed9d15739e4ad`
- `artifacts/autonomous-brain/map05-run-19/summary.json` — SHA256 `28a0d2745f38b8a469bcca72edb7642f2b95edab982f367e623c44c7d5951e90`
- `artifacts/autonomous-brain/map05-run-19/evaluator-stop.json` — SHA256 `592dbf718c3fff4f76bb1ce875106f471d8bc352f7e1d31c097ef916d04c5b68`

评测器 SHA256：`69e4f719afb536af72b55feb0c42835106c633c0491d4725fd9ed549965dccd7`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-19/map-05-run-1 --out <新的报告目录>`。
