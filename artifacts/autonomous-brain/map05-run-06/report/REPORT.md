# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v1`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-06/map-05-run-1`。大脑状态：`failed`；原因：BridgeError: follow_road: NOT_RUNNING。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 46 |
| 大模型调用次数（含非法输出重试） | 49 |
| 大模型累计耗时（秒） | 878.071511 |
| 仿真用时（秒） | 567.380000 |
| 观测次数 | 386 |
| 失败动作数 | 10 |

上限：200 轮 / 1200 秒；达到上限判失败。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终有效送达 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_018 | 38.240000 | 69.140000 | 81.680000 | 未能确定 |
| guangyang-target-2 | target_046 | 391.540000 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | True |
| guangyang-target-2 | False | False | False |

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **18**；平均误差 **1.851299 cm**；RMSE **1.924000 cm**。
无法计入的确认轨迹观测数：1；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 25, 'unmatched': 18}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败动作及原因

| 轮次 | 动作 | 原因及依据 |
|---:|---|---|
| 8 | {"action": "explore", "params": {"exit_angle": 87.7}} | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":33,"frame_id":33,"tick":1308,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":26,"final_observation":34}} |
| 23 | {"action": "go_to", "params": {"object_id": "storage-zone_028"}} | {"success":false,"reason":"remembered_route_did_not_reach_target","evidence":{"after_observation":156,"frame_id":156,"tick":11540,"holding":true,"before_observation":107,"final_observation":157}} |
| 28 | {"action": "go_to", "params": {"object_id": "storage-zone_028"}} | {"success":false,"reason":"remembered_route_did_not_reach_target","evidence":{"after_observation":222,"frame_id":222,"tick":18850,"holding":true,"before_observation":176,"final_observation":223}} |
| 31 | {"action": "go_to", "params": {"object_id": "storage-zone_028"}} | {"success":false,"reason":"remembered_route_did_not_reach_target","evidence":{"after_observation":278,"frame_id":278,"tick":25708,"holding":true,"before_observation":231,"final_observation":279}} |
| 33 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | {"success":false,"reason":"fresh_detection_does_not_verify_standoff","evidence":{"after_observation":288,"frame_id":288,"tick":26187,"holding":true,"object_id":"storage-zone_005","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":0.0,"y":317.0,"w":333.0,"h":163.0},"frame_id":"288","fed_to_world_model":true,"track_id":"storage-zone_005","method":"visible-ground-region-bbox-centre","distance_cm":20.8108048892177,"bearing_deg":-16.071869481359165,"p…（完整内容见 evaluation.json） |
| 35 | {"action": "go_to", "params": {"object_id": "storage-zone_050"}} | {"success":false,"reason":"fresh_detection_does_not_verify_standoff","evidence":{"after_observation":298,"frame_id":298,"tick":26493,"holding":true,"object_id":"storage-zone_050","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":82.0,"y":265.0,"w":501.0,"h":171.0},"frame_id":"298","fed_to_world_model":true,"track_id":"storage-zone_050","method":"visible-ground-region-bbox-centre","distance_cm":24.481849625163253,"bearing_deg":1.4101447726265872,…（完整内容见 evaluation.json） |
| 37 | {"action": "go_to", "params": {"object_id": "storage-zone_050"}} | {"success":false,"reason":"fresh_detection_does_not_verify_standoff","evidence":{"after_observation":306,"frame_id":306,"tick":26721,"holding":true,"object_id":"storage-zone_050","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":82.0,"y":265.0,"w":501.0,"h":171.0},"frame_id":"306","fed_to_world_model":true,"track_id":"storage-zone_050","method":"visible-ground-region-bbox-centre","distance_cm":24.481849625163253,"bearing_deg":1.4101447726265872,…（完整内容见 evaluation.json） |
| 39 | {"action": "go_to", "params": {"object_id": "storage-zone_005"}} | {"success":false,"reason":"fresh_detection_does_not_verify_standoff","evidence":{"after_observation":317,"frame_id":317,"tick":27047,"holding":true,"object_id":"storage-zone_005","detection":{"category":"storage-zone","source":"storage-ground-pixels","confidence":1.0,"bbox":{"x":0.0,"y":345.0,"w":437.0,"h":135.0},"frame_id":"317","fed_to_world_model":true,"track_id":"storage-zone_050","method":"visible-ground-region-bbox-centre","distance_cm":19.375567158765477,"bearing_deg":-10.643564810246255,…（完整内容见 evaluation.json） |
| 44 | {"action": "go_to", "params": {"object_id": "storage-zone_050"}} | {"success":false,"reason":"remembered_route_did_not_reach_target","evidence":{"after_observation":380,"frame_id":380,"tick":28143,"holding":true,"before_observation":334,"final_observation":381}} |
| 46 | {"action": "explore", "params": {}} | {"success":false,"reason":"follow_road: NOT_RUNNING","error_type":"BridgeError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/record.json.gz` — SHA256 `ad603200c1815959fc136ddd719add256487ccbd03c95465997d7e821aee0bb3`
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/captures.json.gz` — SHA256 `d6e972ccd7fadec9c4dc87b8d72b8da28e2e43e4e4637bad61b3da7512ef2941`
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/brain/summary.json` — SHA256 `9b577814cc2abfba1f6b2a43f7f2435c0331e92299ff0cadbfdaac9a8ac90726`
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/brain/rounds.jsonl` — SHA256 `160725dcf03d5e97751432092f892140a9bbe95dc3600ca04a9d7af4f8d807cc`
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/brain/observations.jsonl` — SHA256 `fc8012671bc69e2723b064803244bf8a9b4e26dd013fcaf2077bd90849b054f6`
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/brain/llm.jsonl` — SHA256 `9249538d0ce5e607e87546c9759125686a0310543a7ff81f573a1c017c656848`
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `433ec899e2cb43d36b8ce9d518796160c99a7ea08c9c3c79cad6375c2ee9a7aa`
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/evaluation.json` — SHA256 `82b05a58345b627be2108c9d38e8daceda3f8723475d615dea6b44b49cccd87c`
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/evidence.json` — SHA256 `e6b042e8dfc027d731f9c2f57ee2321851d70f35bcc668f7b6f0e31d55c1e2bc`

评测器 SHA256：`6ed620a9c93858b5d0906b79268bcadb6428bf08a6d92311308ca52475c831b4`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-06/map-05-run-1 --out <新的报告目录>`。
