# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v1`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/map05-run-04/map-05-run-1`。大脑状态：`failed`；原因：LLMRequestError: LLM request failed: URLError; see transcript。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 1 |
| 大模型调用次数（含非法输出重试） | 1 |
| 大模型累计耗时（秒） | 75.585421 |
| 仿真用时（秒） | 0.000000 |
| 观测次数 | 1 |
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
| 1 | null | {"success":false,"reason":"LLM request failed: URLError; see transcript","error_type":"LLMRequestError"} |

失败判定项：no_active_delivery_event:guangyang-target-1；final_position_outside_storage:guangyang-target-1；no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；brain_did_not_finish_with_observed_done；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/map05-run-04/map-05-run-1/record.json.gz` — SHA256 `f5f6660246fcafcff52a7d9e63c47f3a524dbd8ff19e6e6ec67b0d8fe12d199f`
- `artifacts/autonomous-brain/map05-run-04/map-05-run-1/captures.json.gz` — SHA256 `7e0e0e19b0307957ee5a3081e336ebab6c4bbe213f5a24ade1ad245375858701`
- `artifacts/autonomous-brain/map05-run-04/map-05-run-1/brain/summary.json` — SHA256 `baff45c3917363ab68c7933f1694478900df6ed3b2b27a0609aad2e6225f459d`
- `artifacts/autonomous-brain/map05-run-04/map-05-run-1/brain/rounds.jsonl` — SHA256 `c10aebcd9460ed03c500be910b1d177b3a891ca9ede9b1d163dd0dfc74af218f`
- `artifacts/autonomous-brain/map05-run-04/map-05-run-1/brain/observations.jsonl` — SHA256 `cc3befcf5c0843f4e8dc9ca364e12213a8fedbebdeaf66f00dabb0e7a0dff168`
- `artifacts/autonomous-brain/map05-run-04/map-05-run-1/brain/llm.jsonl` — SHA256 `908205de564a1a832baee0c746d635bf9006c70cb48e2ce58002489ea0e2e756`
- `artifacts/autonomous-brain/map05-run-04/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `2a9ca7de2ba277ffbede448f6b744ce9f6b8d934dbbb8dd31dd42c986207db54`
- `artifacts/autonomous-brain/map05-run-04/map-05-run-1/evaluation.json` — SHA256 `9391ee17ef2dc98f504b82a106529d13031b7225bb27701c54346fb0213f5517`
- `artifacts/autonomous-brain/map05-run-04/map-05-run-1/evidence.json` — SHA256 `4816b55464a7f3179c0ccc28b893a6c1b83cdbac62d69af19827776a2794c984`

评测器 SHA256：`6ed620a9c93858b5d0906b79268bcadb6428bf08a6d92311308ca52475c831b4`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-04/map-05-run-1 --out <新的报告目录>`。
