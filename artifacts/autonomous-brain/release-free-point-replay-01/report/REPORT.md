# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v3`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1`。大脑状态：`failed`；原因：round_limit。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 75 |
| 大模型调用次数（含修复与传输重试） | 90 |
| 大模型累计耗时（秒） | 3144.657047 |
| 仿真用时（秒） | 437.880000 |
| 观测次数 | 552 |
| 动作判定失败数 | 13 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 13 |

上限：75 轮 / 1200 秒；达到上限判失败。
最终样本tick：21894；导出结束tick：21894。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_022, target_029 | 2.760000 | 81.980000 | 105.580000 | 220.440000 |
| guangyang-target-2 | target_092, target_115 | 36.640000 | 369.680000 | 395.180000 | 434.780000 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | True | True | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 5 | 5 | 0 | 0 | 0 | 70 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **82**；平均误差 **6.020971 cm**；RMSE **6.577160 cm**。
无法计入的确认轨迹观测数：4；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 123, 'unmatched': 21}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 8 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":38,"frame_id":38,"tick":1477,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":32,"final_observation":39}} |
| 22 | {"action": "go_to", "params": {"object_id": "target_029"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":135,"frame_id":135,"tick":4478,"holding":false,"object_id":"target_029","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9330857142857143,"bbox":{"x":282.0,"y":208.0,"w":56.0,"h":50.0},"frame_id":"135","fed_to_world_model":true,"track_id":"target_029","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":46,"raw_bearing_deg":-1.38,"distance_cm":53.6520437058331…（完整内容见 evaluation.json） |
| 23 | {"action": "go_to", "params": {"object_id": "target_029"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":137,"frame_id":137,"tick":4478,"holding":false,"object_id":"target_029","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9330857142857143,"bbox":{"x":282.0,"y":208.0,"w":56.0,"h":50.0},"frame_id":"137","fed_to_world_model":true,"track_id":"target_029","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":46,"raw_bearing_deg":-1.38,"distance_cm":53.6520437058331…（完整内容见 evaluation.json） |
| 24 | {"action": "explore", "params": {"exit_angle": 28.1}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":145,"frame_id":145,"tick":4988,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":12.2,"elapsedTicks":39},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":1.6,"elapsedTicks":9},"recovery_steps":2,"before_observation":139,"final_observation":146}} |
| 27 | {"action": "go_to", "params": {"object_id": "storage-zone_038"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":198,"frame_id":198,"tick":8487,"holding":true,"object_id":"storage-zone_038","before_observation":163,"final_observation":199}} |
| 29 | {"action": "go_to", "params": {"object_id": "storage-zone_025"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":210,"frame_id":210,"tick":9635,"holding":true,"object_id":"storage-zone_025","before_observation":204,"final_observation":211}} |
| 32 | {"action": "go_to", "params": {"object_id": "storage-zone_056"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":225,"frame_id":225,"tick":9920,"holding":true,"object_id":"storage-zone_056","before_observation":225,"final_observation":226}} |
| 38 | {"action": "explore", "params": {"exit_angle": -99}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":278,"frame_id":278,"tick":11701,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":8.7,"elapsedTicks":74},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.4,"elapsedTicks":74},"recovery_steps":1,"before_observation":274,"final_observation":279}} |
| 44 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":312,"frame_id":312,"tick":13093,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":92},"recovery_steps":1,"before_observation":309,"final_observation":313}} |
| 59 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":416,"frame_id":416,"tick":16631,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.1,"elapsedTicks":10},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.5,"elapsedTicks":68},"recovery_steps":1,"before_observation":413,"final_observation":417}} |
| 61 | {"action": "explore", "params": {"exit_angle": -179}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":433,"frame_id":433,"tick":17408,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":3.1,"elapsedTicks":10},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":12.5,"elapsedTicks":67},"recovery_steps":1,"before_observation":428,"final_observation":434}} |
| 66 | {"action": "go_to", "params": {"object_id": "target_115"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":469,"frame_id":469,"tick":18586,"holding":false,"object_id":"target_115","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9183492063492064,"bbox":{"x":278.0,"y":210.0,"w":84.0,"h":60.0},"frame_id":"469","fed_to_world_model":false,"track_id":"target_115","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":33,"raw_bearing_deg":0.0,"distance_cm":40.3967,"bearing…（完整内容见 evaluation.json） |
| 70 | {"action": "pick", "params": {"object_id": "target_115"}} | action_failure | {"success":false,"reason":"three_grab_attempts_failed","evidence":{"after_observation":495,"frame_id":495,"tick":19280,"holding":false,"object_id":"target_115","attempts":[{"attempt":1,"before_observation":490,"after_observation":491,"holding":false,"alignment":{"mode":"camera_bearing+confirmed_position_odometry","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.9108444444444445,"bbox":{"x":266.0,"y":220.0,"w":110.0,"h":90.0},"frame_id":"490","fed_to_world_model":false,"tra…（完整内容见 evaluation.json） |

失败判定项：round_limit_reached；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/record.json.gz` — SHA256 `9016f23998dfddd0e1260fab69ce19a68d701d45671f24fdba49586ff62617e2`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/captures.json.gz` — SHA256 `d8249ea03cb74e6d8d2af9b8c8011cc5067491717948c0b8c3e3115d78e9abba`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/brain/summary.json` — SHA256 `cf29d35289fd40557cdf633334908a2c08e152654cc44ac5180b1f2c3b6e2a1d`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/brain/rounds.jsonl` — SHA256 `65c2ff9892b613365fcfccce8bd754ba92649955575cf7148778c14caaf98891`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/brain/observations.jsonl` — SHA256 `57fe458665f0b239d5d0f840494e2dd79f656302b9013b2672b9785b5a57d872`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/brain/llm.jsonl` — SHA256 `c5975259411822a169e7878ac89daf6b1172c0934ef2822b6d7568d2bde0886d`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `140c08f0abacfc49c6bf1f8e1f6331fcad8d63587796fc049c155724fa27d433`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/brain/motions.jsonl` — SHA256 `f22ae014d2e3c729ede0dbbc7363fd6adae7bd562de5047b34785e549670c800`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/evaluation.json` — SHA256 `68a2e45244144d3f60772ba491c34d3c444c8be40383f53636e359734c332826`
- `artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1/evidence.json` — SHA256 `061aa532ae1e19280fdfdd71d6afb0343c329a75319ce66115b505f504ccf53f`
- `artifacts/autonomous-brain/release-free-point-replay-01/manifest.json` — SHA256 `e4d541e3022a0be2530ed3897d1513057d10f606d889cdea131fae9ffcfb2ad4`
- `artifacts/autonomous-brain/release-free-point-replay-01/summary.json` — SHA256 `ddcd51f01098ca7cdab61a49e4753e377a0f29cedd26ebf2f9b48574482d4526`

评测器 SHA256：`f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1 --out <新的报告目录>`。
