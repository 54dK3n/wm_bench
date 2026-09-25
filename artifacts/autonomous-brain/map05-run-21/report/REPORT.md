# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v4`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-21/map-05-run-1`。大脑状态：`failed`；原因：LLMRequestError: LLM request failed: HTTPError HTTP 429; see transcript。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 181 |
| 大模型调用次数（含修复与传输重试） | 190 |
| 大模型累计耗时（秒） | 2234.226738 |
| 仿真用时（秒） | 861.320000 |
| 观测次数 | 1104 |
| 动作判定失败数 | 26 |
| 执行或模型错误数 | 1 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 27 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：43066；导出结束tick：43066。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_115 | 2.760000 | 未能确定 | 104.300000 | 281.320000 |
| guangyang-target-2 | target_058, target_112 | 97.200000 | 464.520000 | 482.440000 | 516.920000 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | True | True | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 5 | 2 | 0 | 0 | 3 | 176 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **29**；平均误差 **7.388059 cm**；RMSE **7.407041 cm**。
无法计入的确认轨迹观测数：71；身份冲突轨迹数：2。原始红球检测匹配：{'unique': 145, 'unmatched': 39, 'ambiguous': 8}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 9 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":56,"frame_id":56,"tick":1941,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":48,"final_observation":57}} |
| 13 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":78,"frame_id":78,"tick":2631,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8878541374474053,"bbox":{"x":220.0,"y":204.0,"w":62.0,"h":46.0},"frame_id":"78","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":43,"raw_bearing_deg":-9.42,"distance_cm":51.11990959564657,"…（完整内容见 evaluation.json） |
| 16 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":94,"frame_id":94,"tick":3491,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8972981366459627,"bbox":{"x":232.0,"y":204.0,"w":56.0,"h":46.0},"frame_id":"94","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":47,"raw_bearing_deg":-8.21,"distance_cm":55.10635582173387,"…（完整内容见 evaluation.json） |
| 18 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":106,"frame_id":106,"tick":3723,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8972981366459627,"bbox":{"x":232.0,"y":204.0,"w":56.0,"h":46.0},"frame_id":"106","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":47,"raw_bearing_deg":-8.21,"distance_cm":55.1063558217338…（完整内容见 evaluation.json） |
| 21 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":118,"frame_id":118,"tick":4301,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8997849462365591,"bbox":{"x":326.0,"y":204.0,"w":62.0,"h":42.0},"frame_id":"118","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":42,"raw_bearing_deg":5.09,"distance_cm":49.71616252789825…（完整内容见 evaluation.json） |
| 23 | {"action": "explore", "params": {"exit_angle": 52.1}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":129,"frame_id":129,"tick":4982,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.2,"elapsedTicks":7},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.6,"elapsedTicks":122},"recovery_steps":1,"before_observation":124,"final_observation":130}} |
| 26 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":171,"frame_id":171,"tick":7660,"holding":true,"object_id":"storage-zone_007","before_observation":146,"final_observation":172}} |
| 29 | {"action": "go_to", "params": {"object_id": "storage-zone_019"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":187,"frame_id":187,"tick":8860,"holding":true,"object_id":"storage-zone_019","before_observation":180,"final_observation":188}} |
| 31 | {"action": "go_to", "params": {"object_id": "storage-zone_047"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":199,"frame_id":199,"tick":9092,"holding":true,"object_id":"storage-zone_047","before_observation":199,"final_observation":200}} |
| 37 | {"action": "go_to", "params": {"object_id": "storage-zone_047"}} | action_failure | {"success":false,"reason":"visual_standoff_range_not_supported","evidence":{"after_observation":244,"frame_id":244,"tick":10435,"holding":true,"object_id":"storage-zone_047","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":183.0,"y":236.0,"w":1.0,"h":1.0},"frame_id":"244","fed_to_world_model":true,"track_id":"storage-zone_047","method":"visible-ground-region-bbox-centre","distance_cm":69.48251640451168,"bearing_deg":-16.93135817349978,"position…（完整内容见 evaluation.json） |
| 38 | {"action": "go_to", "params": {"object_id": "storage-zone_047"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":246,"frame_id":246,"tick":10435,"holding":true,"object_id":"storage-zone_047","before_observation":246,"final_observation":247}} |
| 45 | {"action": "place", "params": {}} | action_failure | {"success":false,"reason":"complete_storage_region_not_unique","evidence":{"after_observation":289,"frame_id":289,"tick":12095,"holding":true,"place_trajectory":[],"road_return":{"success":true,"reason":"already_on_observed_road","on_road":true,"anchor_observation":null,"after_observation":289,"motions":[]},"detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":0.0,"y":312.0,"w":323.0,"h":168.0},"frame_id":"289","fed_to_world_model":true,"track_id":"…（完整内容见 evaluation.json） |
| 46 | {"action": "go_to", "params": {"object_id": "storage-zone_064"}} | action_failure | {"success":false,"reason":"visual_standoff_did_not_converge","evidence":{"after_observation":299,"frame_id":299,"tick":12240,"holding":true,"object_id":"storage-zone_064","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":589.0,"y":336.0,"w":51.0,"h":144.0},"frame_id":"299","fed_to_world_model":true,"track_id":"storage-zone_064","method":"visible-ground-region-bbox-centre","distance_cm":22.046244672943658,"bearing_deg":28.707666248052714,"positio…（完整内容见 evaluation.json） |
| 48 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"visual_standoff_target_not_observed","evidence":{"after_observation":313,"frame_id":313,"tick":12532,"holding":true,"object_id":"storage-zone_007","detection":null,"before_observation":311,"final_observation":314}} |
| 56 | {"action": "explore", "params": {"exit_angle": 22.9}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":372,"frame_id":372,"tick":14917,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.4,"elapsedTicks":11},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.8,"elapsedTicks":74},"recovery_steps":1,"before_observation":367,"final_observation":373}} |
| 67 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":439,"frame_id":439,"tick":17337,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":8},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":64},"recovery_steps":2,"before_observation":435,"final_observation":440}} |
| 74 | {"action": "explore", "params": {"exit_angle": 90.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":479,"frame_id":479,"tick":19221,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":92},"recovery_steps":1,"before_observation":474,"final_observation":480}} |
| 79 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":507,"frame_id":507,"tick":20241,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0.6,"elapsedTicks":2},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":10,"elapsedTicks":58},"recovery_steps":1,"before_observation":504,"final_observation":508}} |
| 91 | {"action": "explore", "params": {"exit_angle": 90.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":584,"frame_id":584,"tick":22725,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.1,"elapsedTicks":10},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.5,"elapsedTicks":68},"recovery_steps":1,"before_observation":579,"final_observation":585}} |
| 94 | {"action": "go_to", "params": {"object_id": "target_112"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":608,"frame_id":608,"tick":23666,"holding":false,"object_id":"target_112","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9241215574548908,"bbox":{"x":280.0,"y":208.0,"w":78.0,"h":54.0},"frame_id":"608","fed_to_world_model":false,"track_id":"target_112","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":35,"raw_bearing_deg":-0.14,"distance_cm":42.43419291682…（完整内容见 evaluation.json） |
| 106 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":700,"frame_id":700,"tick":27178,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":0.6,"elapsedTicks":2},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":10,"elapsedTicks":58},"recovery_steps":1,"before_observation":697,"final_observation":701}} |
| 128 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":839,"frame_id":839,"tick":32613,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":831,"final_observation":840}} |
| 130 | {"action": "explore", "params": {"exit_angle": -165.6}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":859,"frame_id":859,"tick":33698,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":851,"final_observation":860}} |
| 143 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":929,"frame_id":929,"tick":36810,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":923,"final_observation":930}} |
| 169 | {"action": "explore", "params": {"exit_angle": 21.4}} | action_failure | {"success":false,"reason":"road_blocked_at_junction","evidence":{"after_observation":1053,"frame_id":1053,"tick":41182,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":16.9,"elapsedTicks":76},"before_observation":1051,"final_observation":1054}} |
| 170 | {"action": "explore", "params": {"exit_angle": -16.7}} | action_failure | {"success":false,"reason":"road_blocked_at_junction","evidence":{"after_observation":1057,"frame_id":1057,"tick":41405,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":28,"elapsedTicks":212},"before_observation":1055,"final_observation":1058}} |
| 181 | null | execution_error | {"success":false,"reason":"LLM request failed: HTTPError HTTP 429; see transcript","error_type":"LLMRequestError"} |

失败判定项：brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/record.json.gz` — SHA256 `a1f08d9cf500a3a6fa41d49d0dac79a8dff173157baf3e80119a64b9e2bdac82`
- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/captures.json.gz` — SHA256 `c816194a7790ac364185d4854d461bd4de9b84e05505f11bfcb265cf22d1dd70`
- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/brain/summary.json` — SHA256 `9fe2dab58fdcba5ec13df0431f85b301edf80cdd45a8cbbc19556458cf961f3e`
- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/brain/rounds.jsonl` — SHA256 `4648437effbb12e818316a6849196fcedd3e850f6cda5b67adf63f3ac7affb33`
- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/brain/observations.jsonl` — SHA256 `f560103c0ed31a305df4cd7cc5bb87617fd46669ee6afda0d62175102276eb8d`
- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/brain/llm.jsonl` — SHA256 `67e84fc24149d1d95c4bd0bceb8afb760225a1f4237abf3ce673262b3d7504d1`
- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `944e28b6a67d4fd618e9121901b6dbf9903b616f20acb108e18e117b48024d79`
- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/brain/motions.jsonl` — SHA256 `1198d21dbc4ac8aa43049fa8d5eb20abe91010796ece1c0b30f21ca01409d27b`
- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/evaluation.json` — SHA256 `866614196112c0ea6fe2d739b4ba518220721aa98f27660f167a8a89ca2f44f6`
- `artifacts/autonomous-brain/map05-run-21/map-05-run-1/evidence.json` — SHA256 `521be05a96c1cfc14a3a64bebdc86dee609f23de796304e2c365d4137b4eb7b9`
- `artifacts/autonomous-brain/map05-run-21/manifest.json` — SHA256 `6dee56ed7150edee6850b9514d4ad5b229999fac6b4e9e4f8ebfd3a8ed4374ee`
- `artifacts/autonomous-brain/map05-run-21/summary.json` — SHA256 `9b4eef3a4650d0c52991b9d40a0b96acafbec0bddaa553617a336e1881dd4fc4`

评测器 SHA256：`69e4f719afb536af72b55feb0c42835106c633c0491d4725fd9ed549965dccd7`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-21/map-05-run-1 --out <新的报告目录>`。
