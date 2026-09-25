# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v3`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-13/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: turn: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 58 |
| 大模型调用次数（含修复与传输重试） | 69 |
| 大模型累计耗时（秒） | 1497.344695 |
| 仿真用时（秒） | 246.080000 |
| 观测次数 | 365 |
| 动作判定失败数 | 6 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 1 |
| 失败轮数合计 | 7 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：12304；导出结束tick：12304。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_019, target_035, target_045 | 2.760000 | 未能确定 | 未能确定 | 未能确定 |
| guangyang-target-2 | target_047, target_077 | 59.840000 | 179.660000 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | False |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 | 0 | 58 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

评估方停止记录：Confirmed target_047 became archived LOST at observation 293. Frozen runtime cannot associate archived identities again, and completion permanently retains ever-confirmed LOST as pending. A sensor-only offline reproduction confirms that a newly independent three-position CONFIRMED track at the same position does not resolve the old obligation. Stop this failed trial before repairing identity reacquisition; no claim of physical target identity or delivery.。
停止后NOT_RUNNING仅在已知停止记录、时间及末轮桥错误相符时单独分类；仍保留整局FAIL，不解释为自主完成。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **11**；平均误差 **13.295977 cm**；RMSE **13.295977 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 71, 'unmatched': 41}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 13 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":80,"frame_id":80,"tick":2405,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":74,"final_observation":81}} |
| 21 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":131,"frame_id":131,"tick":4048,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.2,"elapsedTicks":7},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.6,"elapsedTicks":122},"recovery_steps":1,"before_observation":128,"final_observation":132}} |
| 22 | {"action": "explore", "params": {"exit_angle": 178.8}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":138,"frame_id":138,"tick":4647,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.2,"elapsedTicks":7},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.6,"elapsedTicks":122},"recovery_steps":1,"before_observation":133,"final_observation":139}} |
| 41 | {"action": "explore", "params": {"exit_angle": 90.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":255,"frame_id":255,"tick":8766,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":7.8,"elapsedTicks":25},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.2,"elapsedTicks":92},"recovery_steps":1,"before_observation":250,"final_observation":256}} |
| 44 | {"action": "go_to", "params": {"object_id": "target_047"}} | action_failure | {"success":false,"reason":"final_approach_requires_road_reposition","evidence":{"after_observation":275,"frame_id":275,"tick":9503,"holding":false,"road_clearance":{"requested_cm":10,"permitted_cm":0.0,"heading_error_deg":88.2,"side":"rightClearanceCm","side_clearance_cm":0.1,"front_clearance_cm":145.5,"predicted_lateral_cm":0.0},"before_observation":270,"final_observation":276}} |
| 46 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":290,"frame_id":290,"tick":10137,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":16.3,"elapsedTicks":137},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":17.5,"elapsedTicks":152},"recovery_steps":1,"before_observation":287,"final_observation":291}} |
| 58 | {"action": "look_around", "params": {}} | external_stop | {"success":false,"reason":"turn: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/record.json.gz` — SHA256 `357102e59fb5cefb73e0b8cf601c2dd2ed50641c7e52185a25740eabfb9f597f`
- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/captures.json.gz` — SHA256 `718d5edc7e792b4b5bb1d5014b57259d8c98aa63bb6f2a8012170c879d4b1e43`
- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/brain/summary.json` — SHA256 `537b6a1e80528aba92711e8598efac8a8967cb9aa96e53773d6632c31a197395`
- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/brain/rounds.jsonl` — SHA256 `5002ffb90b891dcb8a8384d87a94d5eb87d28629d01aa9400c915d6e08214bc4`
- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/brain/observations.jsonl` — SHA256 `d6821f9146abfb7ceef75f35d9b30ec32fcbbf73e36460240c4c4aa7c0c6fab1`
- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/brain/llm.jsonl` — SHA256 `cc5a70122c3e808b3f15df967da67b50ff42c5122cc0afbe2f5ddc196d1e522a`
- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `2ff79e6700a98f0dfe98102d9afaf200e7617813cd4659e6b3f027f802d1f4be`
- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/brain/motions.jsonl` — SHA256 `bab5fe23a574f7a9a1877bfbfdc01a705c556d09f056e09b541e76cbd18f9947`
- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/evaluation.json` — SHA256 `ab8e940cefae8c4c12912519c7724051c752876284f9cbc3407fac13e04e85db`
- `artifacts/autonomous-brain/map05-run-13/map-05-run-1/evidence.json` — SHA256 `770f93588a03ec42c5b28090eb4fd92a1152d04bd86c616044ccd9a3a7fef8fa`
- `artifacts/autonomous-brain/map05-run-13/manifest.json` — SHA256 `a59878a9808990b6eef648892e7d60df6a115244d856d3268aab0ca22b83adea`
- `artifacts/autonomous-brain/map05-run-13/summary.json` — SHA256 `04c47e87c4f74784e1ea46504a97c7b1852b927fc9107471d0183de029209445`
- `artifacts/autonomous-brain/map05-run-13/evaluator-stop.json` — SHA256 `d565afe542180d3f009e9d40bffcd6dad5c2390edce4f11be0b031ab2d76db71`

评测器 SHA256：`f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-13/map-05-run-1 --out <新的报告目录>`。

## 身份解释边界（归档补注）

上表的WM轨迹/真值ID来自评测器逐帧同类像素框与真值中心的几何对应算法。它不是跨时刻物理身份相同的独立证明，不能据此断言target_077和target_047是同一物理目标，也不能把评测真值送入brain授权重获。本局target_077只有两次命中、从未CONFIRMED；停止原因所引用的是另行构造的纯传感三位置确认反例，不能把反例伪称为本局已经发生的重获过程。详见相邻上级目录FAILURE_ANALYSIS.md。
