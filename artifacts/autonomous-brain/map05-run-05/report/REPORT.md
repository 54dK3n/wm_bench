# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v1`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-05/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: take_exit: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 42 |
| 大模型调用次数（含非法输出重试） | 47 |
| 大模型累计耗时（秒） | 919.209928 |
| 仿真用时（秒） | 147.520000 |
| 观测次数 | 177 |
| 失败动作数 | 5 |

上限：200 轮 / 1200 秒；达到上限判失败。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终有效送达 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_021 | 42.800000 | 71.820000 | 未能确定 | 未能确定 |
| guangyang-target-2 | 未匹配 | 74.340000 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | False |
| guangyang-target-2 | False | False | False |

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **86**；平均误差 **2.353264 cm**；RMSE **2.597156 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 40, 'unmatched': 39}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败动作及原因

| 轮次 | 动作 | 原因及依据 |
|---:|---|---|
| 9 | {"action": "explore", "params": {"exit_angle": 87.7}} | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":39,"frame_id":39,"tick":1536,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":32,"final_observation":40}} |
| 31 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":130,"frame_id":130,"tick":5266,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":5.6,"elapsedTicks":18},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":15,"elapsedTicks":83},"recovery_steps":2,"before_observation":126,"final_observation":131}} |
| 32 | {"action": "explore", "params": {"exit_angle": 176}} | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":138,"frame_id":138,"tick":5886,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":5.6,"elapsedTicks":18},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":15,"elapsedTicks":83},"recovery_steps":2,"before_observation":132,"final_observation":139}} |
| 41 | {"action": "explore", "params": {}} | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":175,"frame_id":175,"tick":7376,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":2.5,"elapsedTicks":9},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":11.9,"elapsedTicks":64},"recovery_steps":2,"before_observation":171,"final_observation":176}} |
| 42 | {"action": "explore", "params": {"exit_angle": 79.2}} | {"success":false,"reason":"take_exit: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-05/map-05-run-1/record.json.gz` — SHA256 `d3d9a13130fa92f050db0db1a084282e9aa06ea8861398307ad23c9d08e75dcb`
- `artifacts/autonomous-brain/map05-run-05/map-05-run-1/captures.json.gz` — SHA256 `ece29a7e62cefba9688071fb3cf0dbe3bfe4fc80db6d3c133bf160a53c762778`
- `artifacts/autonomous-brain/map05-run-05/map-05-run-1/brain/summary.json` — SHA256 `4a7445103f7b3d799ce917cde221468f27b33e57fcd6575651f41efff634dd61`
- `artifacts/autonomous-brain/map05-run-05/map-05-run-1/brain/rounds.jsonl` — SHA256 `25255b2a1788cdda2af9470727690eca56f9b8e3887a86640021a72e14c3e7ef`
- `artifacts/autonomous-brain/map05-run-05/map-05-run-1/brain/observations.jsonl` — SHA256 `08e517ca1ffaf39b288433ee932aaca2b38d678afa5e15297d911f5c10100afd`
- `artifacts/autonomous-brain/map05-run-05/map-05-run-1/brain/llm.jsonl` — SHA256 `e61e120863496e07780855357afc6ecafdcee784b5f057a4ca43c08a22ab848f`
- `artifacts/autonomous-brain/map05-run-05/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `50ce91e24ce4ba0546f2899913c61dc676df82b5dd467844a6d0fc6a2ce5c0bd`
- `artifacts/autonomous-brain/map05-run-05/map-05-run-1/evaluation.json` — SHA256 `c93e71d7261d4d11d3797697ad5115d63e0e31a9e275d2ab131ad3b3e3c6644b`
- `artifacts/autonomous-brain/map05-run-05/map-05-run-1/evidence.json` — SHA256 `54d04ea3c0bae99d8da35924acca9530efcfc749db82c5fb8bb6855baba73b33`

评测器 SHA256：`6ed620a9c93858b5d0906b79268bcadb6428bf08a6d92311308ca52475c831b4`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-05/map-05-run-1 --out <新的报告目录>`。
