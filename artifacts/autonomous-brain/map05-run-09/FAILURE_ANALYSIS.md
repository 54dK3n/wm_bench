# 第九局：首球有效送达，第二球 pick 接近后离路

结论 **FAIL，完成 1/2 个红球交付**。首球第 39 轮通过传感器放置判断，独立评测也确认原生交付事件未撤销且最终仍在目标存放区内。第二球第 73 轮在抓取前短距离接近时离路，未发出 grab；此后未返回道路，评测侧正常停止并导出。首球成功不能替代双球任务验收；map-05 尚未通过，十布局未开始。

完整依据见 [独立报告](report/REPORT.md)、[机器可读指标](run-metrics.json)和 [原始 brain 日志](map-05-run-1/brain/)。所有数量均由本局原始日志复算。

## 运行指标

| 项目 | 本局结果 |
|---|---:|
| 决策轮数 / 模型调用 | 77 / 89 |
| 模型调用耗时合计 | 2320.6427533739984 秒 |
| 仿真用时 / 终点 tick | 354.56 秒 / 17728 |
| 观测 / 已写入 motion 行 | 393 / 240 |
| pick 动作 / grab 请求 / 成功抓取身份 | 2 / 2 / 1 |
| place 动作 / release 请求 / 有效交付身份 | 1 / 1 / 1 |
| 失败轮数 | 14：13 次动作失败，1 次外部停止后执行失败 |
| 模型传输错误 / 状态校验错误 | 10 / 2；全部重试或修复恢复 |
| brain bridge 请求 / 非白名单请求 | 1814 / 0 |
| 原生审计拒绝请求 / 已接受非白名单请求 | 0 / 0 |

未触及 200 轮或 1200 秒仿真上限。模型耗时是 `llm.jsonl` 的全部 `elapsed_s` 合计，包括重试与修复；brain 墙钟为 2540.007943958 秒，二者均不同于仿真时钟。第 77 轮失败 turn 未成功写入 motion 行，保留于 bridge 记录和终局异常。

## 首球抓取与有效交付

| 事件 | 轮 / 观测或 tick | 仿真时间 |
|---|---|---:|
| 首球首次原始红球观测，绑定 `target_024` | r14 / obs58 | 47.34 秒 |
| 首球首次 CONFIRMED | r21 / obs91 | 73.68 秒 |
| 第一次 grab 后仍未持球 | r27 / obs125 | 99.76 秒 |
| 第二次 grab 的原生成功事件 | r27 / tick5060 | 101.20 秒 |
| 首次持球传感器观测 | r27 / obs127 | 101.48 秒 |
| 后退复核原位置为空，记为 HELD | r27 / obs128，最终 obs129 | 104.68 秒 |
| `go_to(storage-zone_055)` 视觉停靠成功 | r38 / obs205 | 198.64 秒 |
| 首球原生 `package_delivered` 事件 | r39 / tick10103 | 202.06 秒 |
| release 后夹爪为空 | r39 / obs219 | 202.48 秒 |
| 后退观测球在绿色区内，记为 DELIVERED | r39 / obs220 | 205.16 秒 |
| place 返回道路成功，最终动作成功 | r39 / obs224，最终 obs225 | 209.18 秒 |

第 39 轮放置共记录 18 个 motion：12 次对准（7 次 forward、5 次 turn）、1 次 release、1 次 backward 和 4 次返回道路的 forward。放置期间曾离路：全局首次为 obs207 / 199.40 秒；释放前 obs217 已重新在路上，后退观测 obs220 又离路，随后 4 步返回到 obs224 的 `onRoad=true`。因此不能把第 73 轮 obs377 称为本局全局首次离路。

放置依据是 obs220 的唯一当前球/绿色区域像素包含见证，`candidate_witnesses=1`、`holding=false`。球的 raw 距离为 35 cm，未进入 WM 新轨迹准入范围，`ball_track_id=null`；本次没有创建 delivery alias。现有首球身份 `target_024` 被记录为 DELIVERED，后续观测仍按已验证放置位置识别它。该近场无新轨迹的成功不能证明“有新轨迹时的 alias 分支”已在本局经过实测。

独立评测按同帧 bbox 绑定身份，并核验最终 tick17728：首球交付事件仍有效、未持有，最终位置距目标存放区中心 0.5094136392 场景单位，小于原生半径 0.95。第二球无交付事件且最终不在区内，故任务仍为 FAIL。这里没有依赖竞争得分或 brain 自报成功替代独立验收。

## 第二球确认、停靠与 pick 失败

第二球首次原始红球观测为 r23 / obs104 / 86.28 秒；r30 / obs164 / 164.66 秒首次记录 WM 身份 `target_049`，尚未确认。后续 `target_098` 在 r68 / obs355 / 333.02 秒首次 CONFIRMED。独立同帧证据将两个历史 WM 身份都关联到 `guangyang-target-2`；报告保留该多身份历史，没有将其误计为第三个真值球，也未向 brain 注入此关联。

第 72 轮 `go_to(target_098)` 在 obs374 / 345.08 秒成功：新鲜视觉距离 36.4958302 cm、方位 -5.7728096°，均满足当时 go_to 的 25–40 cm / 10°停靠判据。道路仍为 `onRoad=true`，但右侧余量仅 0.6 cm。

第 73 轮只有两个 motion，没有 grab：

| motion 行 | 动作 | 后观测 / 时间 | 道路状态 | 新鲜球方位 |
|---:|---|---|---|---:|
| 231 | turn +5.7728096° | obs376 / 345.16 秒 | onRoad=true，右侧余量 0.6 cm，道路航向误差 53.8° | +0.2402560° |
| 232 | forward 2.5784039 cm | obs377 / 345.44 秒 | onRoad=false，右侧余量 -1.5 cm，横向偏移 10.7 cm | +0.1189469° |

冻结提交 `9d74652735b3834ea7db2c07c64cbbbfdc5ecec3` 的 `autonomous_brain/actions.py:467` 发出这次接近 forward，执行器只返回 `completed=true`，没有 `stoppedBy`，因此下一步进入第 473 行的联合检查。此刻记忆位置结合里程计的距离为 **21.9926314639 cm ≤ 22.5 cm**，新鲜相机方位绝对值 **0.1189468756° ≤ 3°**；三个条件中只有 **`not onRoad` 为真**。动作返回 `visual_alignment_did_not_converge`，`attempts=[]`，没有触发第 478 行的 grab。

失败信息名字不能解释为“距离或朝向未对准”。本局新鲜视觉距离另为 **34.2845690327 cm**（raw 27 cm），与用于近场接近的 WM/里程计距离分别记录；报告未把新鲜距离改写成 21.99 cm，也未声称代码的近场范围判据使用新鲜距离。

日志支持的直接缺口是：短程 pick 接近越过道路边缘后，被 onRoad 条件拒绝抓取，但本次 pick 没有像 place 一样记录/执行返回路径。第 74、76 轮 look_around 正常完成四视角，第 75 轮 go_to 返回 `not_on_observed_road`，没有平移恢复。全局有 31 个离路观测，其中 r39 的 14 个已恢复；r73–77 的 17 个属于最终未恢复阶段。不能据此推导“所有可能动作都已无法成功”，也不能证明移除 onRoad 检查就能安全抓取或完成双球任务。

## 外部正常停止和模型错误

[evaluator-stop.json](evaluator-stop.json) 记录评测侧于 `2026-09-25T09:13:19.350Z`、tick17728 设置既有停止标志，以保存冻结运行后再修复。第 77 轮模型正常输出 look_around，随后 turn 返回 NOT_RUNNING；最终 brain 原样为 `BridgeError: turn: NOT_RUNNING`，子进程退出码 1，driver `status=complete`、正常导出。末轮被独立评测归为 `external_stop`，不计作模型请求失败，也不覆盖此前 13 个动作失败。

模型调用共有 10 次传输错误：6 次 HTTP 502、1 次 URLError、3 次 RemoteDisconnected，全部在同一决策的后续请求恢复。此外调用 17、20 的 go_to 选择了尚未 CONFIRMED 的身份，被状态校验拒绝，分别由调用 18、21 修复。原始输出是有效 JSON，不能称为 JSON 语法错误。77 次决策 + 10 次传输重试 + 2 次状态修复 = 89 条调用记录，逐条恢复关系见 `run-metrics.json`。

独立动作 Judge：首球 pick 和 place 共 2 次与独立证据一致，假阳性 0、假阴性 0；第二球 pick 因没有 grab 为不可独立判定 1 次，其他 74 次动作不在 pick/place 真值 Judge 范围。不可判定不是成功，也不能声称所有 77 个动作都经过真值判断。

已确认红球位置误差统计为 75 个逐观测样本：平均 5.662066 cm、RMSE 6.679918 cm、最大 10.972708 cm；重复 WM 估计会按观测重复计数，不能当作 75 次独立定位。1 个确认样本严格匹配失败，保留未匹配，不填零或使用最近距离兜底。

## 来源与归档校验

- [source-commit.json](source-commit.json)：7 个 brain 文件及 driver 共 8 个文件，Git 冻结提交字节 SHA256 全部匹配启动 manifest、结束 manifest 和适用的 brain summary。`sourcesUnchanged=true`，完整前后 manifest 相等；平台和采集函数的记录哈希前后不变。当前工作树后续修复不用于本局源码证明。
- [archive-integrity.json](archive-integrity.json)：record、samples、sensorAudit、captures 四个 gzip 读取到 EOF，CRC/结尾完整，压缩与展开字节数及 SHA256 全部匹配原 `evidence.json`。record 为 **90,006,252 字节（85.836651 MiB）**，展开 130,331,897 字节；压缩文件低于 100 MiB，无需分片，未重新压缩。
- [llm-replay/README.md](llm-replay/README.md)：77/77 轮、89/89 调用严格离线重放一致，直接使用原始模型状态，全部记录耗尽，除 mode 外完整记录一致；网络调用 0，环境读取尝试 0，原始证据未变。这不是全仿真重放，也不是任务通过。
- 独立 evaluator v2 确认最终 sample tick = simulationEndTick = 17728。首球有效交付、第二球未交付，最终夹爪为空，但没有成功 done；各项门槛均保留。真值只用于导出后的评测，从未向运行中的 brain 提供。

复算时使用新的输出目录，避免覆盖归档：

```text
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-09/map-05-run-1 --out <新的评测目录>
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-09/map-05-run-1 --out <新的离线回放目录>
```

输入 SHA256 见 `run-metrics.json`，评测器 SHA256 见 `report/evaluation.json`，历史保留核验见 `archive-checks.json`。前八局的报告、失败结论和索引条目原样保留。本归档没有修改源码、提交或推送。
