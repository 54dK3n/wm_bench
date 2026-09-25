# 感知离线复放（autonomous-brain-perception/v3）

输入：`artifacts/inloop/v4/stage-1/restore-20260925/acceptance-02/map-05-run-1`。WorldModel 仅接收桥相机检测、相机参数、同 tick 里程计和仿真时间。

共 193 帧；可复放 105 帧，88 帧缺少同 tick 里程计。缺失帧清单见 `summary.json`，没有用 samples 真值补齐。

| 类别 | 首次入库帧 / 仿真秒 | 建轨数 | 曾 CONFIRMED |
|---|---:|---:|---:|
| red-ball | 10 / 10.48 | 2 | 1 |
| blue-ball | 19 / 25.12 | 15 | 1 |
| obstacle | 4 / 2.94 | 31 | 5 |
| storage-zone | 40 / 62.46 | 3 | 2 |

红蓝测距对照覆盖全部 193 帧中的 167 条检测；距离/方位不一致 0 条。对照原生检测器读数只用于评测，未喂给 WorldModel。

| 红球轨迹 | 命中数 | 位姿最小间距 m | 空间跨度 m | 时间跨度 s | 确认时间 s |
|---|---:|---:|---:|---:|---:|
| target_003 | 4 | 0.248204 | 1.690406 | 29.82 | 38.48 |
| target_046 | 2 | 1.618323 | 1.618323 | 39.94 | 未确认 |

这里的首次入库不是摄像头首次看到。轨迹可能随后衰减；曾确认数量不代表当前仍确认，也不保证轨迹等于独立实体。

复现：`python3 tools/replay_brain_perception.py --input artifacts/inloop/v4/stage-1/restore-20260925/acceptance-02/map-05-run-1 --out artifacts/autonomous-brain/perception-replay/new-run`。

`sensor-inputs.jsonl` 是剥离评测数据后的唯一复放输入；`world-model-frames.jsonl` 保存逐帧证据和模型状态；`range-comparison.json` 保存所有原生/复原读数，`summary.json` 保存计数、红球命中位姿和 SHA256。
