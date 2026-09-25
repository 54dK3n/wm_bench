# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v3`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-12/map-05-run-1`。大脑状态：`failed`；原因：LLMRequestError: LLM request failed: HTTPError HTTP 502; see transcript。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 14 |
| 大模型调用次数（含修复与传输重试） | 17 |
| 大模型累计耗时（秒） | 326.578322 |
| 仿真用时（秒） | 45.980000 |
| 观测次数 | 70 |
| 动作判定失败数 | 1 |
| 执行或模型错误数 | 1 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 2 |

上限：200 轮 / 1200 秒；达到上限判失败。
最终样本tick：2299；导出结束tick：2299。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_024 | 2.760000 | 未能确定 | 未能确定 | 未能确定 |
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
| 0 | 0 | 0 | 0 | 0 | 14 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **0**；平均误差 **未能确定 cm**；RMSE **未能确定 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 5, 'unmatched': 2}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 9 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":40,"frame_id":40,"tick":1477,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":34,"final_observation":41}} |
| 14 | null | execution_error | {"success":false,"reason":"LLM request failed: HTTPError HTTP 502; see transcript","error_type":"LLMRequestError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/record.json.gz` — SHA256 `f65ed8daa46096d30f6565305076cdca434f814c0fae0420a38d0387934a1e8e`
- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/captures.json.gz` — SHA256 `4d5b1979cf88d7fcf26d5504cc623bfc7b03ae3d7d5a4aeca475b5c2c38834b0`
- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/brain/summary.json` — SHA256 `ab8a0ad5161d3a1c2e6cbd015cfa00e2bff49074095f570ce72b4229d0410e39`
- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/brain/rounds.jsonl` — SHA256 `335e8f10d16f46a41027edcbc460adb41181ac4bcdf5c05c2dfd7a832f0a17ed`
- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/brain/observations.jsonl` — SHA256 `66fda4222d1d2f41de8cfddbc6530764f67065c8c38f1c6d19651d5aee9ba839`
- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/brain/llm.jsonl` — SHA256 `df99c39cc5c0e215b2cb6294f2ffa67c4bd326555a5547d640572c87bdeb7b57`
- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `b02319f6677c0a166856bf0e108a0f0766dc607c10e8e942b683dbb8f7f53f1a`
- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/brain/motions.jsonl` — SHA256 `dcfb55dc6098be19191909fa7f7e8288b6d9f8a82aee297d8ec1447710bcabb9`
- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/evaluation.json` — SHA256 `1755b2e95622da604c3ef0798d39561ff7db5ec67e5118e9ee3ae4d85d1959c9`
- `artifacts/autonomous-brain/map05-run-12/map-05-run-1/evidence.json` — SHA256 `8245b574816db2222f3bb8a8c773bbf34e6f7653f1ce5eb30423654713dd56a8`
- `artifacts/autonomous-brain/map05-run-12/manifest.json` — SHA256 `a59878a9808990b6eef648892e7d60df6a115244d856d3268aab0ca22b83adea`
- `artifacts/autonomous-brain/map05-run-12/summary.json` — SHA256 `815df4af41e4e5b23d2452cef4e0880adbe0c55fde5bf5ae295736184febd4ba`

评测器 SHA256：`f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-12/map-05-run-1 --out <新的报告目录>`。
