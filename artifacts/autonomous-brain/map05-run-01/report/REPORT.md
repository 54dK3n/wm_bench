# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v1`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-01/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: odometry: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 40 |
| 大模型调用次数（含非法输出重试） | 40 |
| 大模型累计耗时（秒） | 447.027970 |
| 仿真用时（秒） | 100.880000 |
| 观测次数 | 176 |
| 失败动作数 | 17 |

上限：200 轮 / 1200 秒；达到上限判失败。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终有效送达 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_018 | 42.600000 | 未能确定 | 未能确定 | 未能确定 |
| guangyang-target-2 | 未匹配 | 未能确定 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | False |
| guangyang-target-2 | False | False | False |

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **0**；平均误差 **未能确定 cm**；RMSE **未能确定 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 1, 'unmatched': 1}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败动作及原因

| 轮次 | 动作 | 原因及依据 |
|---:|---|---|
| 4 | {"action": "explore", "params": {"exit_angle": 0.8}} | {"success":false,"reason":"exit_angle_requires_a_current_junction","evidence":{"after_observation":13,"frame_id":13,"tick":426,"holding":false,"before_observation":13,"final_observation":14}} |
| 6 | {"action": "explore", "params": {"exit_angle": 0.8}} | {"success":false,"reason":"exit_angle_requires_a_current_junction","evidence":{"after_observation":18,"frame_id":18,"tick":493,"holding":false,"before_observation":18,"final_observation":19}} |
| 9 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_backed_away_for_observation","evidence":{"after_observation":35,"frame_id":35,"tick":1130,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"junction","distanceCm":0,"elapsedTicks":0},"before_observation":30,"final_observation":36}} |
| 11 | {"action": "explore", "params": {"exit_angle": 177.7}} | {"success":false,"reason":"exit_angle_requires_a_current_junction","evidence":{"after_observation":43,"frame_id":43,"tick":1358,"holding":false,"before_observation":43,"final_observation":44}} |
| 13 | {"action": "explore", "params": {"exit_angle": 14.9}} | {"success":false,"reason":"requested_exit_not_observed","evidence":{"after_observation":50,"frame_id":50,"tick":1513,"holding":false,"available_exits":[{"angle_deg":180,"heading_deg":-90,"visits":0,"completed":true,"blocked":false},{"angle_deg":87.7,"heading_deg":177.7,"visits":0,"completed":false,"blocked":false},{"angle_deg":-75.1,"heading_deg":14.900000000000006,"visits":0,"completed":false,"blocked":false}],"before_observation":50,"final_observation":51}} |
| 21 | {"action": "explore", "params": {"exit_angle": 160.6}} | {"success":false,"reason":"exit_angle_requires_a_current_junction","evidence":{"after_observation":80,"frame_id":80,"tick":2617,"holding":false,"before_observation":80,"final_observation":81}} |
| 24 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_backed_away_for_observation","evidence":{"after_observation":96,"frame_id":96,"tick":3267,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.8,"elapsedTicks":9},"before_observation":92,"final_observation":97}} |
| 25 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_backed_away_for_observation","evidence":{"after_observation":102,"frame_id":102,"tick":3525,"holding":false,"actuator_result":{"accepted":false,"stoppedBy":"off_road","distanceCm":0,"elapsedTicks":0},"before_observation":98,"final_observation":103}} |
| 27 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_backed_away_for_observation","evidence":{"after_observation":114,"frame_id":114,"tick":3892,"holding":false,"actuator_result":{"accepted":false,"stoppedBy":"off_road","distanceCm":0,"elapsedTicks":0},"before_observation":110,"final_observation":115}} |
| 28 | {"action": "explore", "params": {"exit_angle": 160.6}} | {"success":false,"reason":"exit_angle_requires_a_current_junction","evidence":{"after_observation":116,"frame_id":116,"tick":3892,"holding":false,"before_observation":116,"final_observation":117}} |
| 30 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_backed_away_for_observation","evidence":{"after_observation":128,"frame_id":128,"tick":4123,"holding":false,"actuator_result":{"accepted":false,"stoppedBy":"off_road","distanceCm":0,"elapsedTicks":0},"before_observation":124,"final_observation":129}} |
| 32 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_backed_away_for_observation","evidence":{"after_observation":140,"frame_id":140,"tick":4354,"holding":false,"actuator_result":{"accepted":false,"stoppedBy":"off_road","distanceCm":0,"elapsedTicks":0},"before_observation":136,"final_observation":141}} |
| 33 | {"action": "explore", "params": {"exit_angle": 11.3}} | {"success":false,"reason":"exit_angle_requires_a_current_junction","evidence":{"after_observation":142,"frame_id":142,"tick":4354,"holding":false,"before_observation":142,"final_observation":143}} |
| 35 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_backed_away_for_observation","evidence":{"after_observation":154,"frame_id":154,"tick":4585,"holding":false,"actuator_result":{"accepted":false,"stoppedBy":"off_road","distanceCm":0,"elapsedTicks":0},"before_observation":150,"final_observation":155}} |
| 37 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_backed_away_for_observation","evidence":{"after_observation":166,"frame_id":166,"tick":4816,"holding":false,"actuator_result":{"accepted":false,"stoppedBy":"off_road","distanceCm":0,"elapsedTicks":0},"before_observation":162,"final_observation":167}} |
| 38 | {"action": "explore", "params": {"exit_angle": 177.7}} | {"success":false,"reason":"exit_angle_requires_a_current_junction","evidence":{"after_observation":168,"frame_id":168,"tick":4816,"holding":false,"before_observation":168,"final_observation":169}} |
| 40 | {"action": "explore", "params": {"exit_angle": 11.3}} | {"success":false,"reason":"odometry: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-01/map-05-run-1/record.json.gz` — SHA256 `f9b3f5a24d39e7ebe17778013b71f99ed5f16bdc5bdf21b64e9d81c311a7a9ed`
- `artifacts/autonomous-brain/map05-run-01/map-05-run-1/captures.json.gz` — SHA256 `3d6f5f6d7c5e2080a5bd93c7a500af27edeb68468cd3b4dc14bfb57a20a0c127`
- `artifacts/autonomous-brain/map05-run-01/map-05-run-1/brain/summary.json` — SHA256 `372c20021a3b1dd0576fdeb93df67f0bff1d58b6cf9a2a3900371a0c16b758c1`
- `artifacts/autonomous-brain/map05-run-01/map-05-run-1/brain/rounds.jsonl` — SHA256 `3481f9394fc6950bd3a9f84b51b0fe8b3e8c5feb7b5942d2e8a53737a036adcc`
- `artifacts/autonomous-brain/map05-run-01/map-05-run-1/brain/observations.jsonl` — SHA256 `5c93d6bfbe79cde0b956308e271865a0d8bbd12796a8af52c840692bb9faae52`
- `artifacts/autonomous-brain/map05-run-01/map-05-run-1/brain/llm.jsonl` — SHA256 `478a457cc6ee10dd69515d59b70540431efdc74cf8fa69a242033fe15e8ad84f`
- `artifacts/autonomous-brain/map05-run-01/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `9e9e4c74f5829f76c407c275d998813081641afde1008bce74d0e843bc305a69`
- `artifacts/autonomous-brain/map05-run-01/map-05-run-1/evaluation.json` — SHA256 `dba7bd8e6cf7f7c0de9e161a5cca9e9d7ad9396f390375659000712e705257f9`
- `artifacts/autonomous-brain/map05-run-01/map-05-run-1/evidence.json` — SHA256 `da1154a8d1bec4e42f9144a5207fd32e23f590035088ee60e545d7817d221c0e`

评测器 SHA256：`6ed620a9c93858b5d0906b79268bcadb6428bf08a6d92311308ca52475c831b4`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-01/map-05-run-1 --out <新的报告目录>`。
