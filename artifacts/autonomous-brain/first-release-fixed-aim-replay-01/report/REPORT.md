# 小车自主大脑离线评测：map-05

结论：**FAIL**。评测器版本 `autonomous-brain-offline-evaluation/v3`。
结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。

输入目录：`artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1`。大脑状态：`failed`；原因：round_limit。

| 指标 | 结果 |
|---|---:|
| 总轮数 | 33 |
| 大模型调用次数（含修复与传输重试） | 39 |
| 大模型累计耗时（秒） | 737.825693 |
| 仿真用时（秒） | 190.040000 |
| 观测次数 | 218 |
| 动作判定失败数 | 4 |
| 执行或模型错误数 | 0 |
| 评估方停止后的错误 | 0 |
| 失败轮数合计 | 4 |

上限：33 轮 / 1200 秒；达到上限判失败。
最终样本tick：9502；导出结束tick：9502。
末轮成功done及最终观测交叉核验：False；源码记录核验：verified。

## 每球时间线

下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。

| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |
|---|---|---:|---:|---:|---:|
| guangyang-target-1 | target_025, target_031 | 2.760000 | 75.480000 | 90.780000 | 186.940000 |
| guangyang-target-2 | 未匹配 | 41.280000 | 未能确定 | 未能确定 | 未能确定 |

## 最终真值核对

| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |
|---|---|---|---|
| guangyang-target-1 | True | True | False |
| guangyang-target-2 | False | False | False |

## 独立 Judge 对照

仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。

| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |
|---:|---:|---:|---:|---:|---:|
| 2 | 2 | 0 | 0 | 0 | 31 |

逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。

## WorldModel 位置误差

仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。

样本数 **21**；平均误差 **1.514426 cm**；RMSE **1.514426 cm**。
无法计入的确认轨迹观测数：0；身份冲突轨迹数：0。原始红球检测匹配：{'unique': 40, 'unmatched': 36}。
几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。

## 失败轮次及原因

| 轮次 | 动作 | 分类 | 原因及依据 |
|---:|---|---|---|
| 9 | {"action": "explore", "params": {}} | action_failure | {"success":false,"reason":"road_blocked_returned_to_junction","evidence":{"after_observation":48,"frame_id":48,"tick":1709,"holding":false,"actuator_result":{"accepted":true,"stoppedBy":"front_clearance","distanceCm":13.8,"elapsedTicks":58},"recovery_result":{"accepted":true,"stoppedBy":"junction","distanceCm":3.2,"elapsedTicks":21},"recovery_steps":3,"before_observation":42,"final_observation":49}} |
| 23 | {"action": "go_to", "params": {"object_id": "storage-zone_027"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":167,"frame_id":167,"tick":7041,"holding":true,"object_id":"storage-zone_027","before_observation":141,"final_observation":168}} |
| 26 | {"action": "go_to", "params": {"object_id": "storage-zone_007"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":183,"frame_id":183,"tick":8241,"holding":true,"object_id":"storage-zone_007","before_observation":176,"final_observation":184}} |
| 28 | {"action": "go_to", "params": {"object_id": "storage-zone_053"}} | action_failure | {"success":false,"reason":"known_route_exhausted_needs_exploration","evidence":{"after_observation":188,"frame_id":188,"tick":8294,"holding":true,"object_id":"storage-zone_053","before_observation":188,"final_observation":189}} |

失败判定项：no_active_delivery_event:guangyang-target-2；final_position_outside_storage:guangyang-target-2；round_limit_reached；brain_did_not_finish_with_observed_done；terminal_done_not_corroborated；execution_or_controller_error。

## 完整日志与复算

以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。

- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/record.json.gz` — SHA256 `bf377aa169475cefebb2001789fa7a39b0888b72065e25081ae6e2ae0a914032`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/captures.json.gz` — SHA256 `c06294caa184f39e486a368ab99eef761e780770de71215eb4c332fa8fc29da6`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/brain/summary.json` — SHA256 `75459600c11c7c7488558c638e1c1278cedf18fbbdd2cbdd68b8f6fc20a58f0b`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/brain/rounds.jsonl` — SHA256 `367668b2090d289327eca2616d2a6ae3aca7881f54425a2a8c55208440c8ec4c`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/brain/observations.jsonl` — SHA256 `50e1dac19b543a11e3045f732fcdf681d998b55093f32235bdef9c1cb9aa2e3b`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/brain/llm.jsonl` — SHA256 `73cb0ea9b1596fe8c68a064c4cc1c414dc87a20f9ac87734ed07ec5b982968f8`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/brain/bridge-calls.jsonl` — SHA256 `64f133a204686c45589a27fd7235d71d642fdbc2a3ad3c1e44a4538513815e76`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/brain/motions.jsonl` — SHA256 `7822ef7d28b2a9bad96249536c4e61e96c35a0e5e33a54402884d1bf79c6a156`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/evaluation.json` — SHA256 `55e6197846b57af227026b2f2d1144d33c607986e57b7195f743fea5ebbe6319`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1/evidence.json` — SHA256 `9125bc2eebaa3f076acca1c0c4daee1c9b7b088d94a44bffd3935f68329921f2`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/manifest.json` — SHA256 `594d8d4fecd5b849cc3d4f4f1aae6e2cd214c2d47ab8ad522193fddd5b4d69bf`
- `artifacts/autonomous-brain/first-release-fixed-aim-replay-01/summary.json` — SHA256 `155bbeee6aca8c2c7a6d6df9844ba80575cdcd73193be7fd22a148738c035234`

评测器 SHA256：`f65cf386055dff76a3b8d59547bca8b9009657581310957add58bc1f495b914f`。

复算：`python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/first-release-fixed-aim-replay-01/map-05-run-1 --out <新的报告目录>`。
