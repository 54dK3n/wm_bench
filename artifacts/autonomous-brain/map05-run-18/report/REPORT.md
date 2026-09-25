# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v3`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-18/map-05-run-1`。大脑状态：`None`；原因：None。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 167 |
| 大模型调用次数（含修复与传输重试） | 200 |
| 大模型累计耗时（秒） | 6663.330370 |
| 仿真用时（秒） | 855.940000 |
| 观测次数 | 1116 |
| 动作判定失败数 | 23 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 23 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：42797；导出结束tick：42797。
末轮成功done及最终观测交叉核验：False；源码记录核验：mismatch。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_021, target_101 | 2.760000 | 未能确定 | 105.580000 | 220.100000 |
| guangyang-target-2 | target_054, target_136, target_147, target_159 | 41.280000 | 未能确定 | 426.120000 | 470.880000 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | True | True | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 5 | 0 | 0 | 0 | 5 | 162 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **0**；平均误差 **未能确定 cm**；RMSE **未能确定 cm**。
无法计入的确认轨迹观测数：86；身份冲突轨迹数：2。原始红球检测匹配：{'unique': 201, 'unmatched': 77, 'ambiguous': 15}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 8 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":46,"frame_id":46,"tick":1709,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":38,"final_observation":47}} |
| 21 | {"action": "go_to", "params": {"object_id": "target_032"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":133,"frame_id":133,"tick":4478,"holding":false,"object_id":"target_032","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9330857142857143,"bbox":{"x":282.0,"y":208.0,"w":56.0,"h":50.0},"frame_id":"133","fed_to_world_model":true,"track_id":"target_032","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":46,"raw_bearing_deg":-1.38,"distance_cm":53.6520437058331…（完整内容见 evaluation.json） |
| 22 | {"action": "explore", "params": {"exit_angle": 28.1}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":141,"frame_id":141,"tick":4988,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":12.2,"elapsedTicks":39},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":1.6,"elapsedTicks":9},"recovery_steps":2,"before_observation":135,"final_observation":142}} |
| 25 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":194,"frame_id":194,"tick":8487,"holding":true,"object_id":"storage-zone_007","before_observation":159,"final_observation":195}} |
| 28 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":210,"frame_id":210,"tick":9687,"holding":true,"object_id":"storage-zone_007","before_observation":203,"final_observation":211}} |
| 31 | {"action": "go_to", "params": {"object_id": "storage-zone_055"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":225,"frame_id":225,"tick":9972,"holding":true,"object_id":"storage-zone_055","before_observation":225,"final_observation":226}} |
| 62 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":405,"frame_id":405,"tick":15911,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":64},"recovery_steps":2,"before_observation":401,"final_observation":406}} |
| 71 | {"action": "explore", "params": {"exit_angle": 90.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":458,"frame_id":458,"tick":18027,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":92},"recovery_steps":1,"before_observation":453,"final_observation":459}} |
| 81 | {"action": "go_to", "params": {"object_id": "target_114"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":532,"frame_id":532,"tick":20133,"holding":false,"object_id":"target_114","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9183492063492064,"bbox":{"x":278.0,"y":210.0,"w":84.0,"h":60.0},"frame_id":"532","fed_to_world_model":false,"track_id":"target_114","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":33,"raw_bearing_deg":0.0,"distance_cm":40.3967,"bearing…（完整内容见 evaluation.json） |
| 83 | {"action": "go_to", "params": {"object_id": "target_114"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":544,"frame_id":544,"tick":20365,"holding":false,"object_id":"target_114","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9183492063492064,"bbox":{"x":278.0,"y":210.0,"w":84.0,"h":60.0},"frame_id":"544","fed_to_world_model":false,"track_id":"target_114","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":33,"raw_bearing_deg":0.0,"distance_cm":40.3967,"bearing…（完整内容见 evaluation.json） |
| 87 | {"action": "pick", "params": {"object_id": "target_114"}} | action_failure | {"success":false,"reason":"three_grab_attempts_failed","evidence":{"after_observation":570,"frame_id":570,"tick":21059,"holding":false,"object_id":"target_114","attempts":[{"attempt":1,"before_observation":565,"after_observation":566,"holding":false,"alignment":{"mode":"camera_bearing+confirmed_position_odometry","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9108444444444445,"bbox":{"x":266.0,"y":220.0,"w":110.0,"h":90.0},"frame_id":"565","fed_to_world_model":false,"tra…（完整内容见 evaluation.json） |
| 90 | {"action": "go_to", "params": {"object_id": "storage-zone_069"}} | action_failure | {"success":false,"reason":"route_no_progress","evidence":{"after_observation":600,"frame_id":600,"tick":22340,"holding":true,"object_id":"storage-zone_069","waypoint":[-0.156,0.865],"before_observation":587,"final_observation":601}} |
| 94 | {"action": "explore", "params": {"exit_angle": -103.6}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":634,"frame_id":634,"tick":24259,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":629,"final_observation":635}} |
| 113 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":766,"frame_id":766,"tick":29206,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0.6,"elapsedTicks":2},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":10,"elapsedTicks":58},"recovery_steps":1,"before_observation":763,"final_observation":767}} |
| 122 | {"action": "explore", "params": {"exit_angle": 22.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":825,"frame_id":825,"tick":31372,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":820,"final_observation":826}} |
| 123 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":832,"frame_id":832,"tick":31917,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":827,"final_observation":833}} |
| 127 | {"action": "explore", "params": {"exit_angle": -102.5}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":863,"frame_id":863,"tick":33530,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":858,"final_observation":864}} |
| 128 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":870,"frame_id":870,"tick":34075,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":865,"final_observation":871}} |
| 130 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":887,"frame_id":887,"tick":34852,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":882,"final_observation":888}} |
| 135 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":922,"frame_id":922,"tick":35942,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0.6,"elapsedTicks":2},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":10,"elapsedTicks":58},"recovery_steps":1,"before_observation":919,"final_observation":923}} |
| 142 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":969,"frame_id":969,"tick":37254,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":966,"final_observation":970}} |
| 143 | {"action": "explore", "params": {"exit_angle": 144.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":976,"frame_id":976,"tick":37799,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":69},"recovery_steps":1,"before_observation":971,"final_observation":977}} |
| 166 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":1110,"frame_id":1110,"tick":42552,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":6.6,"elapsedTicks":21},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12,"elapsedTicks":65},"recovery_steps":2,"before_observation":1106,"final_observation":1111}} |

失败判定项：missing_input:brain/summary.json；source_proof_brain_summary_hash_mismatch；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-18/map-05-run-1/record.json.gz` — SHA256 `7f7fd954b493410c95670f19d3d2b6e1f29e3a43cfb889398ba622d6a381fad3`
- `artifacts/autonomous-brain/map05-run-18/map-05-run-1/captures.json.gz` — SHA256 `1d628e4d57f2a4bcce26724fa41888c1abbe0eb4e102aedf5783d7f0cacc9ce7`
- `artifacts/autonomous-brain/map05-run-18/map-05-run-1/brain/rounds.jsonl` — SHA256 `77c921f75b38919ba82b4b7e74f22b87087d551dccf54db61be5ea8e0538596d`
- `artifacts/autonomous-brain/map05-run-18/map-05-run-1/brain/observations.jsonl` — SHA256 `240e649512898d96c6fdc3d91046a7bdd54a3ec800e6e917525cb84affa73f30`
- `artifacts/autonomous-brain/map05-run-18/map-05-run-1/brain/llm.jsonl` — SHA256 `8826b3fb96902fceb3341b4d902cf9f89ba62e6ba18f99ad7abd272294d20b34`
- `artifacts/autonomous-brain/map05-run-18/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `402c5b89e28ab18870cad35b8960bed80cb4175d095b9725d2e4fde888bc43ca`
- `artifacts/autonomous-brain/map05-run-18/map-05-run-1/brain/motions.jsonl` — SHA256 `a79cc44bdccb980c7c13daa724f331be6098fcd7a5893799c196071706d32df7`
- `artifacts/autonomous-brain/map05-run-18/map-05-run-1/evaluation.json` — SHA256 `767c28fee37a4c597cb5458ad817184b9960f755f2b388bbe3ceab8e7a65bae4`
- `artifacts/autonomous-brain/map05-run-18/map-05-run-1/evidence.json` — SHA256 `c144711480882850e7a4f658afc1eec9d4a40740bc070a2b29aac262d62ef010`
- `artifacts/autonomous-brain/map05-run-18/manifest.json` — SHA256 `594d8d4fecd5b849cc3d4f4f1aae6e2cd214c2d47ab8ad522193fddd5b4d69bf`
- `artifacts/autonomous-brain/map05-run-18/summary.json` — SHA256 `0bad20cd549b8169802954e979d21f3d4f8627301a89c47ed29a18e49aeae890`

评测器 SHA256：`f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-18/map-05-run-1 --out <新的报告目录>`。
