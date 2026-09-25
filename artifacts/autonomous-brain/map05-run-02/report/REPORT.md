# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v1`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-02/map-05-run-1`。大脑状态：`failed`；原因：LLMRequestError: LLM request failed: timeout; see transcript。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 8 |
| 大模型调用次数（含非法输出重试） | 8 |
| 大模型累计耗时（秒） | 162.621409 |
| 仿真用时（秒） | 17.440000 |
| 观测次数 | 29 |
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
| 8 | null | {"success":false,"reason":"LLM request failed: timeout; see transcript","error_type":"LLMRequestError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-02/map-05-run-1/record.json.gz` — SHA256 `17c084cc0b11ac63425fd006f58d596b72609f57cae07b13a7f331cec3cb9487`
- `artifacts/autonomous-brain/map05-run-02/map-05-run-1/captures.json.gz` — SHA256 `ff2bc80caa5c7bb1e3eed5244d88006df86f14878c22ef4b2842a9dbfdf8ed3f`
- `artifacts/autonomous-brain/map05-run-02/map-05-run-1/brain/summary.json` — SHA256 `c078412075e490afb8fe9ff6d8282d860b3322bab1a5ee35afaf1bb5089e8191`
- `artifacts/autonomous-brain/map05-run-02/map-05-run-1/brain/rounds.jsonl` — SHA256 `8c33a08f8a8b5fda1face9275a08d2942abf7948f2fda7fad986eaaf813957c2`
- `artifacts/autonomous-brain/map05-run-02/map-05-run-1/brain/observations.jsonl` — SHA256 `285a5a59453113baf2c1e8ff75736639449676d3d26ae54cd79a0e9006f06877`
- `artifacts/autonomous-brain/map05-run-02/map-05-run-1/brain/llm.jsonl` — SHA256 `1b683ba20b48b40a6173137ead044642f4bb07d78bbe11ddbef17dd5df808ed2`
- `artifacts/autonomous-brain/map05-run-02/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `2d1f824f3123e1cf97601d1c706158b49a8fc5179354676c8419c38c72e4d691`
- `artifacts/autonomous-brain/map05-run-02/map-05-run-1/evaluation.json` — SHA256 `ef8c472dac33f824fb27c2d6ce5d383a594c5e2f92d35efe5d158fa77ad2966c`
- `artifacts/autonomous-brain/map05-run-02/map-05-run-1/evidence.json` — SHA256 `0e8742dd55db5eea1df34758f9360b780669b0d3385f03033725c20d116c5fc7`

评测器 SHA256：`6ed620a9c93858b5d0906b79268bcadb6428bf08a6d92311308ca52475c831b4`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-02/map-05-run-1 --out <新的报告目录>`。
