# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v1`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/transport-smoke-02/map-05-run-1`。大脑状态：`failed`；原因：LLMOutputError: LLM output invalid after one repair; see transcript。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 3 |
| 大模型调用次数（含非法输出重试） | 4 |
| 大模型累计耗时（秒） | 0.003999 |
| 仿真用时（秒） | 6.180000 |
| 观测次数 | 10 |
| 失败动作数 | 1 |

上限：5 轮 / 1200 秒；达到上限判失败。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终有效送达 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | 未匹配 | 2.760000 | 未能确定 | 未能确定 | 未能确定 |
| guangyang-target-2 | 未匹配 | 未能确定 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | False | False | False |
| guangyang-target-2 | False | False | False |

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **0**；平均误差 **未能确定 cm**；RMSE **未能确定 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 1}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败动作及原因

| 轮次 | 动作 | 原因及依据 |
|---:|---|---|
| 3 | null | {"success":false,"reason":"LLM output invalid after one repair; see transcript","error_type":"LLMOutputError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/transport-smoke-02/map-05-run-1/record.json.gz` — SHA256 `1037cabbd0f0bb76b20b202a62bfa7f6c5c08d5c276b58a1f4482c16eb119e24`
- `artifacts/autonomous-brain/transport-smoke-02/map-05-run-1/captures.json.gz` — SHA256 `90fd4a84a009df360f9254003c344deda85d5a201e96e663b58efe3dd01ff2d8`
- `artifacts/autonomous-brain/transport-smoke-02/map-05-run-1/brain/summary.json` — SHA256 `01d9a91774b348c274d3e9c8b0a4c122eb1994060e1679121c293e5b536dbddd`
- `artifacts/autonomous-brain/transport-smoke-02/map-05-run-1/brain/rounds.jsonl` — SHA256 `0d73c53a89eb44753c064bd95979ac0e4d09dd910bbdec742b55e685ed1e6b93`
- `artifacts/autonomous-brain/transport-smoke-02/map-05-run-1/brain/observations.jsonl` — SHA256 `9482b239f2f2cf46fccb042e9a4adbe46f3313220fed4985670cf978e0dbfcbf`
- `artifacts/autonomous-brain/transport-smoke-02/map-05-run-1/brain/llm.jsonl` — SHA256 `51b020592a56c1836f5e4b178078a600d44480c86b0fa38dd0f61852206b6fef`
- `artifacts/autonomous-brain/transport-smoke-02/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `436eec4cc4641af169d99aee7f20f0dde329227d3bef1274cad811eff8de7c89`
- `artifacts/autonomous-brain/transport-smoke-02/map-05-run-1/evaluation.json` — SHA256 `24c957b18573f4a549fd3184125385e73fda569e7fdbd9900649d3544c7df294`
- `artifacts/autonomous-brain/transport-smoke-02/map-05-run-1/evidence.json` — SHA256 `9c3baec602d0ad428c27685615ff4e2a30933a400c049c8953e9cc95d381ad0e`

评测器 SHA256：`6ed620a9c93858b5d0906b79268bcadb6428bf08a6d92311308ca52475c831b4`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/transport-smoke-02/map-05-run-1 --out <新的报告目录>`。
