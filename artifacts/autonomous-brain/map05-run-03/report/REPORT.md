# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v1`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-03/map-05-run-1`。大脑状态：`failed`；原因：LLMRequestError: LLM request failed: RemoteDisconnected; see transcript。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 2 |
| 大模型调用次数（含非法输出重试） | 2 |
| 大模型累计耗时（秒） | 112.149277 |
| 仿真用时（秒） | 1.620000 |
| 观测次数 | 4 |
| 失败动作数 | 1 |

上限：200 轮 / 1200 秒；达到上限判失败。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终有效送达 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | 未匹配 | 未能确定 | 未能确定 | 未能确定 | 未能确定 |
| guangyang-target-2 | 未匹配 | 未能确定 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | False |
| guangyang-target-2 | False | False | False |

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **0**；平均误差 **未能确定 cm**；RMSE **未能确定 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败动作及原因

| 轮次 | 动作 | 原因及依据 |
|---:|---|---|
| 2 | null | {"success":false,"reason":"LLM request failed: RemoteDisconnected; see transcript","error_type":"LLMRequestError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-03/map-05-run-1/record.json.gz` — SHA256 `1ee092a431212c975b5f75a58315f8a4831204210a98b3f4f4ff1c3e34f150b2`
- `artifacts/autonomous-brain/map05-run-03/map-05-run-1/captures.json.gz` — SHA256 `c873db178aafc186968375a25063ada879ec79c5109eb48d338ef565d25b4a64`
- `artifacts/autonomous-brain/map05-run-03/map-05-run-1/brain/summary.json` — SHA256 `dcc2642194c9995f391f38892b4155573df9a9730b14e9244d6413841ede93c0`
- `artifacts/autonomous-brain/map05-run-03/map-05-run-1/brain/rounds.jsonl` — SHA256 `f1dbbbefb198462c23073131c818d713218bfccf7a41ffe07b808fac1c4d2f7f`
- `artifacts/autonomous-brain/map05-run-03/map-05-run-1/brain/observations.jsonl` — SHA256 `6872d7f2535507563d2b75b7e71b2344826c98ec7ba4d429fe2d266a9b5f998a`
- `artifacts/autonomous-brain/map05-run-03/map-05-run-1/brain/llm.jsonl` — SHA256 `7b4f713bbf1c48637b991b5d8486e623017a55be34b27e33082f9a8dc6874055`
- `artifacts/autonomous-brain/map05-run-03/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `5d2a8a0d7c72e0d44f2fe48af7e6b7b44058f918c96246bf5a77e87d3b1eec83`
- `artifacts/autonomous-brain/map05-run-03/map-05-run-1/evaluation.json` — SHA256 `a03f2431459b28f103f5447dff70ce5bf3961b8227abe8330c660d13f1f61752`
- `artifacts/autonomous-brain/map05-run-03/map-05-run-1/evidence.json` — SHA256 `f3b38e40b46b9b8910c9943f4dd0cef27875a2b805fc9393318c3fb540fa3285`

评测器 SHA256：`6ed620a9c93858b5d0906b79268bcadb6428bf08a6d92311308ca52475c831b4`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-03/map-05-run-1 --out <新的报告目录>`。
