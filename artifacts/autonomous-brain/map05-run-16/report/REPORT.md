# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v3`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-16/map-05-run-1`。大脑状态：`failed`；原因：LLMRequestError: LLM request failed: HTTPError HTTP 502; see transcript。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 20 |
| 大模型调用次数（含修复与传输重试） | 22 |
| 大模型累计耗时（秒） | 576.579307 |
| 仿真用时（秒） | 73.960000 |
| 观测次数 | 117 |
| 动作判定失败数 | 4 |
| 执行或模型错误数 | 1 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 5 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：3698；导出结束tick：3698。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_021 | 2.760000 | 54.100000 | 未能确定 | 未能确定 |
| guangyang-target-2 | 未匹配 | 未能确定 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | False |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 | 0 | 20 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **36**；平均误差 **10.039856 cm**；RMSE **10.205957 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 24, 'unmatched': 6}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 9 | {"action": "explore", "params": {"exit_angle": 87.7}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":56,"frame_id":56,"tick":1941,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":48,"final_observation":57}} |
| 14 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":88,"frame_id":88,"tick":2863,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8878541374474053,"bbox":{"x":220.0,"y":204.0,"w":62.0,"h":46.0},"frame_id":"88","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":43,"raw_bearing_deg":-9.42,"distance_cm":51.11990959564657,"…（完整内容见 evaluation.json） |
| 16 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":97,"frame_id":97,"tick":3152,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8955900621118013,"bbox":{"x":294.0,"y":204.0,"w":56.0,"h":46.0},"frame_id":"97","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":46,"raw_bearing_deg":0.28,"distance_cm":53.640303916514654,"…（完整内容见 evaluation.json） |
| 18 | {"action": "go_to", "params": {"object_id": "target_021"}} | action_failure | {"success":false,"reason":"visual_standoff_requires_road_reposition","evidence":{"after_observation":105,"frame_id":105,"tick":3466,"holding":false,"object_id":"target_021","detection":{"category":"red-ball","source":"virtual-cv","confidence":0.8943333333333333,"bbox":{"x":252.0,"y":202.0,"w":60.0,"h":44.0},"frame_id":"105","fed_to_world_model":true,"track_id":"target_021","method":"virtual-cv-published-width-formula+M5","raw_distance_cm":44,"raw_bearing_deg":-5.22,"distance_cm":51.7698105439457…（完整内容见 evaluation.json） |
| 20 | null | execution_error | {"success":false,"reason":"LLM request failed: HTTPError HTTP 502; see transcript","error_type":"LLMRequestError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/record.json.gz` — SHA256 `5d2652af8c49f678a6768195b150cd9ced07aae4cbfa879ed070d3ecffe2e4ec`
- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/captures.json.gz` — SHA256 `45903d756e6684085ef09a01f46ea6b4492fab44f42635d1ba19e5758884b3ef`
- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/brain/summary.json` — SHA256 `d015204e87babe8dd78416f550ba53d9d752c04f02cb5e2df53658cdd298d144`
- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/brain/rounds.jsonl` — SHA256 `1f5524463b1a101385dc50b67d537898e77709e342c4a3ac1aa063bf095a5891`
- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/brain/observations.jsonl` — SHA256 `b0efd3a058bf4b9cef5d8d1bb253f0647931ac71089a042a402f4d6e8a119270`
- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/brain/llm.jsonl` — SHA256 `22a796f30500906fec8243d9d2bd80da90341e1ac6c6e791e530a1e436fd97cf`
- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `a33ce2a7f76586a6f5c1f8c3b2d8605592366d627bcc3c0b6adb96ecd43c7b50`
- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/brain/motions.jsonl` — SHA256 `db0cf061f02cc1d741a3b94d0aaf6bb14cdf31f88da987f38323ca9e012b31e7`
- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/evaluation.json` — SHA256 `e3bd157c3ca1b432b6a4d4225c6263745abee97a404087434bfc34addb4e8b09`
- `artifacts/autonomous-brain/map05-run-16/map-05-run-1/evidence.json` — SHA256 `de697e5c1516cf2ccc69b5fb64de6b4d2986cfe3374ed3f2c9d1593193c361bd`
- `artifacts/autonomous-brain/map05-run-16/manifest.json` — SHA256 `67d8d994e1280f256bfb7bc8d22d8e30e505bec322b052a3db7e8d9b36fdc092`
- `artifacts/autonomous-brain/map05-run-16/summary.json` — SHA256 `98903c217b998f2e07d1e6f4d0b36724c14fdb288b1a22d5022b181a6714f79d`

评测器 SHA256：`f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-16/map-05-run-1 --out <新的报告目录>`。
