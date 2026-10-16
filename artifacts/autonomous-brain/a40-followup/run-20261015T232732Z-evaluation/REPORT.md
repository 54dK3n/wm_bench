# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v9`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1`。大脑状态：`aborted`；原因：SIGTERM: stopped_during_action。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 26 |
| 大模型调用次数（含修复与传输重试） | 26 |
| 大模型累计耗时（秒） | 140.897319 |
| 仿真用时（秒） | 105.020000 |
| 观测次数 | 140 |
| 动作判定失败数 | 6 |
| 执行或模型错误数 | 1 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 7 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：5251；导出结束tick：5251。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_013 | 2.760000 | 60.680000 | 未能确定 | 未能确定 |
| guangyang-target-2 | 未匹配 | 22.280000 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | False |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 2 | 2 | 0 | 0 | 0 | 24 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **50**；平均误差 **4.893141 cm**；RMSE **4.957817 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 62, 'unmatched': 10}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 9 | {"action": "explore", "params": {"discovery_id": "red-discovery-2"}} | action_failure | {"success":false,"reason":"confirmation_no_safe_independent_viewpoint","evidence":{"after_observation":35,"frame_id":35,"tick":822,"holding":false,"confirmation_sampling":{"schema":"brain-confirmation-sampling/v5","discovery_id":"red-discovery-2","initial_object_id":"target_013","confirmed_object_id":null,"initial_hit_count":1,"final_hit_count":1,"independent_hits_added":0,"max_steps":12,"max_travel_cm":120,"travelled_cm":8.0,"steps":[{"method":"forward","params":{"distanceCm":4.0,"speed":30},"p…（完整内容见 evaluation.json） |
| 10 | {"action": "explore", "params": {"exit_angle": 0}} | action_failure | {"success":false,"reason":"road_node_observed_without_completed_traversal","evidence":{"after_observation":38,"frame_id":38,"tick":1087,"holding":false,"road_progress":{"schema":"brain-explore-road-progress/v1","status":"road_node_connection_unverified","before_observation":37,"after_observation":38,"start_node_id":"junction-13","end_node_id":"junction-16","start_anchor_observation":37,"end_anchor_observation":38,"new_traversal_ids":["traversal-3"],"arrival_traversal_ids":[],"different_node_veri…（完整内容见 evaluation.json） |
| 15 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_observed_node","evidence":{"after_observation":65,"frame_id":65,"tick":2085,"holding":false,"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.6,"elapsedTicks":122},"recovery_steps":1,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.2,"elapsedTicks":7},"road_progress":{"schema":"brain-explore-road-progress/v1","status":"road_node_connection_unverified","before_observation":62,"after_observat…（完整内容见 evaluation.json） |
| 16 | {"action": "explore", "params": {"discovery_id": "red-discovery-21"}} | action_failure | {"success":false,"reason":"confirmation_no_safe_independent_viewpoint","evidence":{"after_observation":67,"frame_id":67,"tick":2085,"holding":false,"confirmation_sampling":{"schema":"brain-confirmation-sampling/v5","discovery_id":"red-discovery-21","initial_object_id":null,"confirmed_object_id":null,"initial_hit_count":0,"final_hit_count":0,"independent_hits_added":0,"max_steps":12,"max_travel_cm":120,"travelled_cm":0.0,"steps":[],"source_discovery_id":"red-discovery-21","last_viewpoint_comparis…（完整内容见 evaluation.json） |
| 24 | {"action": "pick", "params": {"object_id": "target_013"}} | action_failure | {"success":false,"reason":"grab_identity_not_uniquely_visible","evidence":{"after_observation":120,"frame_id":120,"tick":4736,"holding":false,"object_id":"target_013","attempts":[{"attempt":1,"before_observation":112,"after_observation":113,"holding":false,"alignment":{"mode":"camera_bearing+confirmed_position_odometry","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.90171219374824,"bbox":{"x":254.0,"y":222.0,"w":134.0,"h":106.0},"frame_id":"112","fed_to_world_model":fals…（完整内容见 evaluation.json） |
| 25 | {"action": "pick", "params": {"object_id": "target_013"}} | action_failure | {"success":false,"reason":"grab_identity_not_uniquely_visible","evidence":{"after_observation":138,"frame_id":138,"tick":5125,"holding":false,"object_id":"target_013","attempts":[{"attempt":1,"before_observation":126,"after_observation":127,"holding":false,"alignment":{"mode":"camera_bearing+confirmed_position_odometry","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8956043956043955,"bbox":{"x":244.0,"y":226.0,"w":154.0,"h":130.0},"frame_id":"126","fed_to_world_model":fa…（完整内容见 evaluation.json） |
| 26 | {"action": "explore", "params": {}} | execution_error | {"success":false,"reason":"interrupted_during_action","error_type":"KeyboardInterrupt","evidence":{"interruption":{"signal":"SIGTERM","requested_phase":"action","requested_round":26,"requested_observation":140,"aborting_signal":"SIGTERM","stopped_phase":"action","active_round":26,"completed_rounds":25,"action":{"action":"explore","params":{}},"before_observation":140,"last_observation":140,"bridge_sequence":655,"odometry":{"rightCm":-132.3,"forwardCm":136.3,"headingDeg":134.9,"distanceCm":763.8,…（完整内容见 evaluation.json） |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error；task_completion:required_delivery_count_not_met；done_not_selected_in_recorded_llm_call；done_post_action_completion_not_corroborated。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/record.json.gz` — SHA256 `5ddbd2dddc3de0b95e432efaec294f5072eb421fa9360e04745e44e2d76cb8f7`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/captures.json.gz` — SHA256 `a815c35641c609c357e746670c81c7bbc017f551f9ad0e7d4ce2e38313148817`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/brain/summary.json` — SHA256 `919d4f6b0fef36120f8aef45c479f9815b791eadb3a92e35529ef470eb04171c`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/brain/rounds.jsonl` — SHA256 `78d7bfba7c76e80323b62999a39393739463960f9bebd51780ef841d2fd54fae`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/brain/observations.jsonl` — SHA256 `34b37af95bd679130788589b061a29b70ea67b69311d8e96ce71ebab4ebe3adc`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/brain/llm.jsonl` — SHA256 `9bf7ff2663e680510b04cd2c66ca12f0a068587964c88e9d05d2ab7d143fea6d`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `49b8bfbf3c1f3f18ced116ef6e789e653c09351e82136f3b943d05717b6b64d9`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/brain/motions.jsonl` — SHA256 `0c78ac65620cead6fc5c3596018ef30579a26360c705f9852ae1c623c05c2009`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/evaluation.json` — SHA256 `9b9da5231e03942670c44d603ef25af9da702c2d8af65f9d6d3ca88d751bde6a`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/evidence.json` — SHA256 `22afb04398ab8e97b04f47beae6821dd1b7c909cf9e35f7f8140f8a586b68015`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/manifest.json` — SHA256 `9de487241b3dab51cad8497f941186781225b1bef7fa43e4891bf5254bf9db3c`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/summary.json` — SHA256 `927699ede3def41fbd1b57138c9546025da09d34b49756b2b68918a8f0cdc18a`
- `artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1/brain/llm.lifecycle.jsonl` — SHA256 `2e20b2c6f712014cdb2ce3a7db49f32ed153aded0121d5a5f5c2394737af655a`

评测器 SHA256：`a7bfd08cceae971432c40d5188ece959182f929f1796e7c570f6dd7e8ac3cc04`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/a40-followup/run-20261015T232732Z/map-05-run-1 --out <新的报告目录>`。
