# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v4`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-20/map-05-run-1`。大脑状态：`failed`；原因：round_limit。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 200 |
| 大模型调用次数（含修复与传输重试） | 216 |
| 大模型累计耗时（秒） | 2591.529288 |
| 仿真用时（秒） | 1077.680000 |
| 观测次数 | 1376 |
| 动作判定失败数 | 27 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 27 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：53884；导出结束tick：53884。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_025, target_107 | 2.760000 | 未能确定 | 114.860000 | 234.040000 |
| guangyang-target-2 | target_056, target_150, target_156, target_169, target_189 | 45.920000 | 未能确定 | 481.920000 | 564.440000 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | True | True | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 4 | 0 | 0 | 0 | 4 | 196 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **0**；平均误差 **未能确定 cm**；RMSE **未能确定 cm**。
无法计入的确认轨迹观测数：96；身份冲突轨迹数：3。原始红球检测匹配：{'unique': 227, 'unmatched': 62, 'ambiguous': 21}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 10 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":58,"frame_id":58,"tick":1941,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":52,"final_observation":59}} |
| 24 | {"action": "go_to", "params": {"object_id": "target_031"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":147,"frame_id":147,"tick":4710,"holding":false,"object_id":"target_031","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9330857142857143,"bbox":{"x":282.0,"y":208.0,"w":56.0,"h":50.0},"frame_id":"147","fed_to_world_model":true,"track_id":"target_031","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":46,"raw_bearing_deg":-1.38,"distance_cm":53.6520437058331…（完整内容见 evaluation.json） |
| 26 | {"action": "explore", "params": {"exit_angle": 28.1}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":165,"frame_id":165,"tick":5452,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":12.2,"elapsedTicks":39},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":1.6,"elapsedTicks":9},"recovery_steps":2,"before_observation":159,"final_observation":166}} |
| 29 | {"action": "go_to", "params": {"object_id": "storage-zone_039"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":218,"frame_id":218,"tick":8951,"holding":true,"object_id":"storage-zone_039","before_observation":183,"final_observation":219}} |
| 33 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":244,"frame_id":244,"tick":10383,"holding":true,"object_id":"storage-zone_007","before_observation":237,"final_observation":245}} |
| 35 | {"action": "go_to", "params": {"object_id": "storage-zone_058"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":256,"frame_id":256,"tick":10615,"holding":true,"object_id":"storage-zone_058","before_observation":256,"final_observation":257}} |
| 39 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":280,"frame_id":280,"tick":11475,"holding":true,"object_id":"storage-zone_007","before_observation":279,"final_observation":281}} |
| 45 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":316,"frame_id":316,"tick":12551,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.4,"elapsedTicks":11},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.8,"elapsedTicks":74},"recovery_steps":1,"before_observation":313,"final_observation":317}} |
| 46 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":323,"frame_id":323,"tick":13104,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.4,"elapsedTicks":11},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.8,"elapsedTicks":74},"recovery_steps":1,"before_observation":318,"final_observation":324}} |
| 83 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":544,"frame_id":544,"tick":20400,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":92},"recovery_steps":1,"before_observation":541,"final_observation":545}} |
| 89 | {"action": "explore", "params": {"exit_angle": 90.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":581,"frame_id":581,"tick":21624,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.1,"elapsedTicks":10},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.5,"elapsedTicks":67},"recovery_steps":1,"before_observation":576,"final_observation":582}} |
| 94 | {"action": "go_to", "params": {"object_id": "target_111"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":612,"frame_id":612,"tick":22682,"holding":false,"object_id":"target_111","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9239126305792973,"bbox":{"x":282.0,"y":208.0,"w":78.0,"h":54.0},"frame_id":"612","fed_to_world_model":false,"track_id":"target_111","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":35,"raw_bearing_deg":0.14,"distance_cm":42.434192916826…（完整内容见 evaluation.json） |
| 96 | {"action": "go_to", "params": {"object_id": "target_111"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":624,"frame_id":624,"tick":22914,"holding":false,"object_id":"target_111","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9239126305792973,"bbox":{"x":282.0,"y":208.0,"w":78.0,"h":54.0},"frame_id":"624","fed_to_world_model":false,"track_id":"target_111","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":35,"raw_bearing_deg":0.14,"distance_cm":42.434192916826…（完整内容见 evaluation.json） |
| 102 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"route_no_progress","evidence":{"after_observation":682,"frame_id":682,"tick":25465,"holding":true,"object_id":"storage-zone_007","waypoint":[-0.156,0.865],"before_observation":666,"final_observation":683}} |
| 107 | {"action": "explore", "params": {"exit_angle": -103.6}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":733,"frame_id":733,"tick":28937,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":728,"final_observation":734}} |
| 116 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":800,"frame_id":800,"tick":30723,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0.6,"elapsedTicks":2},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":10,"elapsedTicks":58},"recovery_steps":1,"before_observation":797,"final_observation":801}} |
| 130 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":899,"frame_id":899,"tick":33922,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0.6,"elapsedTicks":2},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":10,"elapsedTicks":58},"recovery_steps":1,"before_observation":896,"final_observation":900}} |
| 133 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":918,"frame_id":918,"tick":34687,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0.6,"elapsedTicks":2},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":10,"elapsedTicks":58},"recovery_steps":1,"before_observation":915,"final_observation":919}} |
| 146 | {"action": "explore", "params": {"exit_angle": 22.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1017,"frame_id":1017,"tick":37781,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":1012,"final_observation":1018}} |
| 148 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1034,"frame_id":1034,"tick":38558,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":1029,"final_observation":1035}} |
| 149 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1041,"frame_id":1041,"tick":39103,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":1036,"final_observation":1042}} |
| 168 | {"action": "explore", "params": {"exit_angle": -102.5}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1170,"frame_id":1170,"tick":44406,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":1165,"final_observation":1171}} |
| 170 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1187,"frame_id":1187,"tick":45183,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":1182,"final_observation":1188}} |
| 185 | {"action": "explore", "params": {"exit_angle": -90.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1283,"frame_id":1283,"tick":49346,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":92},"recovery_steps":1,"before_observation":1278,"final_observation":1284}} |
| 191 | {"action": "explore", "params": {"exit_angle": -90}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1320,"frame_id":1320,"tick":51024,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0.6,"elapsedTicks":2},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":10,"elapsedTicks":58},"recovery_steps":1,"before_observation":1315,"final_observation":1321}} |
| 198 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1363,"frame_id":1363,"tick":53057,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":1360,"final_observation":1364}} |
| 199 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1370,"frame_id":1370,"tick":53602,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":1365,"final_observation":1371}} |

失败判定项：round_limit_reached；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/record.json.gz` — SHA256 `c2295736ba0744639d85780586be0dbb040979a421ee1e6134a0b4ec661cb7bf`
- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/captures.json.gz` — SHA256 `d37c8acd95b818e685a6caa179b5d6312f2da79d7fc49ed738f3c6449c7312bc`
- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/brain/summary.json` — SHA256 `5da22cc3d7429ee221255995c5ae3b80d36455598989b3b24fa5fb3e9ec26f71`
- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/brain/rounds.jsonl` — SHA256 `8030f3ca05d42bcb7786358bc8a5ab7892788770010899c73e4ed07ec8ef83c4`
- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/brain/observations.jsonl` — SHA256 `0399d14b81b43f11e520bd33f119ecfec76fdde4477411d0b10dd54113e142d8`
- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/brain/llm.jsonl` — SHA256 `51a232facce37d2d56e76d56d9d6d439a135a7edfab07a9ce48ae05e03a44d96`
- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `2c2529e5db38161eea4cb4f6b29ca219c4e0be703e500c3de2d3fcb038f253c7`
- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/brain/motions.jsonl` — SHA256 `0541a5ec027290ba5e99d5dd9566989ebf73f4b8fa0c1ffb107e16fc5ee6ddcc`
- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/evaluation.json` — SHA256 `cc2f7d53d94256ce18c8d5e4fd8c8fb7047bb07198c5187b2fa8f5008bc6ce56`
- `artifacts/autonomous-brain/map05-run-20/map-05-run-1/evidence.json` — SHA256 `c040b8a45e403adde689d11b079a605bf8e9aa5f7237af5374263ca3ea1aa1bd`
- `artifacts/autonomous-brain/map05-run-20/manifest.json` — SHA256 `5603097545471a281672a25152be8c654d7f7b29e658c79fc5d82e32f9c3d55f`
- `artifacts/autonomous-brain/map05-run-20/summary.json` — SHA256 `7769e45ff0fb4b39008b4359989d7bff354ecf3d5c1b30ed80e0334025d30299`

评测器 SHA256：`69e4f719afb536af72b55feb0c42835106c633c0491d4725fd9ed549965dccd7`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-20/map-05-run-1 --out <新的报告目录>`。
