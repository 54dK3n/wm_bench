# 第八局：place 对准预算耗尽，离路持球后正常停止

结论 **FAIL**。本局抓取一个红球，但没有执行 `release`，没有交付事件；停止时仍持球。独立评测同时检查原生 record 的交付事件、最终真值位置、终点采样时刻、终局 done、运行上限和来源完整性，未放宽任何成功条件。[独立报告](report/REPORT.md)、[机器可读指标](run-metrics.json)、[原始 brain 日志](map-05-run-1/brain/)保留全部失败证据。map-05 尚未通过，十布局未开始。

## 可复算指标

| 项目 | 本局结果 |
|---|---:|
| 决策轮数 / 模型调用 | 54 / 64 |
| 模型调用耗时合计 | 1442.4293853300005 秒 |
| 仿真用时 | 226.04 秒；终点 tick 11302 |
| 观测 / 成功写入的 motion 行 | 263 / 156 |
| 抓取动作 / 原生 grab 请求 | 1 / 2 |
| place 动作 / release 请求 / 有效交付 | 1 / 0 / 0 |
| 失败轮数 | 12：11 次动作返回失败，1 次外部停止后执行失败 |
| 模型传输错误 / 校验错误 | 10 / 0；传输错误全部重试恢复 |
| brain bridge 请求 / 非白名单请求 | 1210 / 0 |
| 原生审计拒绝请求 / 已接受非白名单请求 | 0 / 0 |

轮数上限 200、仿真上限 1200 秒均未触及；模型耗时是 `brain/llm.jsonl` 各行 `elapsed_s` 之和，包括失败请求及重试，不等于仿真时钟或运行墙钟。156 个 motion 行不包含第 54 轮抛错、未完成写入的 turn 请求，后者由 bridge 日志和终局异常保留。

## 首次观测、确认与抓取

| 事件 | 轮 / 观测 | 仿真时间 | 依据 |
|---|---|---:|---|
| 首球第一次原始红球观测 | r14 / obs58 | 47.34 秒 | 同帧 bbox 唯一绑定 `guangyang-target-1`，WM `target_021` |
| 第二球第一次原始红球观测 | r17 / obs73 | 60.10 秒 | 同帧 bbox 唯一绑定 `guangyang-target-2`；没有稳定 WM 身份或确认 |
| 首球首次 CONFIRMED | r21 / obs91 | 73.68 秒 | `target_021` 的已记录确认状态 |
| 首球 go_to 成功 | r27 / obs115 | 88.44 秒 | 新鲜相机距离 28.1727398860 cm、方位 0.3349693295° |
| 第一次 grab 后仍未持球 | r28 / obs117 | 89.34 秒 | `holding=false` |
| 第二次 grab 原生成功事件 | r28 / tick4539 | 90.78 秒 | record 的 `package_grabbed` 绑定首球 |
| 首次传感器持球 | r28 / obs119 | 91.06 秒 | `holding=true` |
| 后退复核原位置为空并记为 HELD | r28 / obs120，最终 obs121 | 94.26 秒 | `old_position_matches=0`，`grasp_observed` |

第一次 grab 前，新鲜视觉距离 28.1727 cm，WM 记忆结合里程计的距离 20.7281 cm；两者在原始 evidence 中分开保留。前进 6 cm 后第二次 grab，新鲜视觉距离为 21.0425 cm，记忆结合里程计距离 14.7353 cm。本报告没有用其中一个替换另一个。

独立位置误差统计包含 28 个已记录 CONFIRMED 红球样本：均值/RMSE/最大值约 1.265561 cm；这些是逐观测样本，多次重复同一 WM 估计，不能称为 28 次独立定位。另有 1 个已确认样本无法按严格同帧规则匹配，保留为未匹配，未使用最近距离兜底。

## 存放区停靠与 place 失败

第 46 轮 `go_to(storage-zone_053)` 在 obs232 / 214.22 秒通过视觉停靠判据：新鲜绿色区域距离 33.8865303 cm、方位 2.5651246°。当时 `onRoad=true`，但左侧余量只有 0.1 cm、道路航向误差 -44.3°。这是 go_to 的停靠成功，尚不是球在存放区内的证据。

第 47 轮从 obs233 开始执行 place。冻结提交 `fa5c0f18487171a5d294080500deccb54f718d4d` 的 `autonomous_brain/actions.py:527` 将转向和前进共同计入 8 次循环；先要求方位绝对值不超过 3°，再要求距离不超过 19 cm，循环耗尽就在第 541 行返回失败，`release` 位于第 545 行。本局的动作序列如下，数值来自 motion 与其后观测，未改写阈值：

| motion 行 | 动作 | 后观测 | 仿真时间 | 最近绿色区域距离 / 方位 | onRoad |
|---:|---|---:|---:|---|---|
| 141 | forward 7 cm | 234 | 214.98 | 23.8832 cm / 3.5857° | false |
| 142 | turn -3.5857° | 235 | 215.04 | 23.8983 cm / -1.2347° | false |
| 143 | forward 5.8983 cm | 236 | 215.68 | 21.2945 cm / 0° | false |
| 144 | forward 3.2945 cm | 237 | 216.04 | 20.7190 cm / 0° | false |
| 145 | forward 2.7190 cm | 238 | 216.34 | 21.3471 cm / 19.3271° | false |
| 146 | turn -19.3271° | 239 | 216.60 | 20.2544 cm / 6.9127° | false |
| 147 | turn -6.9127° | 240 | 216.70 | 19.9294 cm / -1.1816° | false |
| 148 | forward 1.9294 cm | 241 | 216.92 | 19.5022 cm / -4.6845° | false |

第一次前进后 obs234 就是本局首次离路观测；随后有 30 个离路观测。8 次动作共 5 次前进、3 次转向；最终距离和方位仍不满足释放条件，返回 `storage_alignment_did_not_converge`。obs236 起多帧绿色区域 bbox 触及画面边界，末帧 bbox 为 `{x:39,y:333,w:474,h:147}`，下缘恰为 480。这里的距离是可见绿色像素区域 bbox 中点的投影，不是完整存放区中心或球的包含关系，不能据此宣布送达，也不能据此断言只增加循环预算就能成功。

第 48、51 轮 look_around 各获得四个视角；第 49、50 轮 go_to 和第 52、53 轮 explore 均返回 `not_on_observed_road`，没有执行移动恢复。日志支持“当前选取的恢复路径未产生平移进展”，不支持“所有可能动作均已不可能成功”；评测侧因此正常中止、保存证据再修复。

## 正常停止与模型错误分开记录

[evaluator-stop.json](evaluator-stop.json) 记录评测侧于 `2026-09-25T08:16:21.937Z`、tick11302 设置已有的停止标志。第 54 轮模型仍正常产生 `look_around`；随后 turn 返回 `NOT_RUNNING`，brain 最终原样记录 `BridgeError: turn: NOT_RUNNING`。driver 已正常导出且 `status=complete`，brain 子进程退出码为 1，任务保持失败。这个末轮执行异常归为 `external_stop`，不是模型请求失败，也不将此前 11 个动作失败抹去。

本局确实有 10 次传输错误：4 次 URLError（调用 11、16、20、62），6 次 HTTP 502（21、29、37、38、52、59），全部在同一次决策的后续调用恢复。第 18、32 次决策各重试两次；总计 54 个决策、64 条调用记录。每条错误的恢复调用号见 [run-metrics.json](run-metrics.json)。

独立 Judge 只对可可靠绑定红球身份、前后样本和对应 grab/release 的 pick/place 给出判断。本局 pick 与独立证据一致 1 次，假阳性 0、假阴性 0；place 因没有 release 被标为不可独立判定 1 次，其余 52 次动作不在此 Judge 范围。不可判定不是成功，其他动作也没有被伪装成真值已验证。

## 后续合成回归不能改写本局事实

后续合成测试发现“释放后新 WM 身份可能残留为待处理目标”的独立身份问题；该问题发生在释放、视觉交付确认之后。本局没有 release，未调用交付标记路径，也没有成功放置或交付后重观测，因此没有触发这个身份问题。它应保留为后续修复依据，不能充当本局失败原因或本局已送达的证据。

## 归档与复现边界

- [source-commit.json](source-commit.json)：冻结提交中的 7 个 brain 文件和 driver 共 8 个文件逐文件 SHA256，全部匹配启动 manifest、结束 manifest 及适用的 brain summary；`sourcesUnchanged=true`，完整前后 manifest 相等。平台与采集函数的记录哈希前后相等；未拿后续工作树源码代替本局源码。
- [archive-integrity.json](archive-integrity.json)：4 个 gzip 全部读到 EOF，压缩与展开字节数、SHA256 都与 `evidence.json` 相符。record 为 60,693,998 字节（57.882307 MiB），展开 87,767,924 字节，低于 100 MiB，无需分块。原压缩包未重写。
- [llm-replay/README.md](llm-replay/README.md)：54/54 轮、64/64 调用严格离线重放一致；原状态直接重放，全部记录耗尽，除 mode 外完整记录一致，网络调用 0，环境读取尝试 0，原始证据未改动。这不是全仿真重放或任务成功。
- 独立 evaluator v2 确认最终 sample tick = simulationEndTick = 11302；两球均无有效交付事件且最终不在目标存放区，首球仍被持有，终局无成功 done。详细真值仅在评测归档内使用，没有输入运行中的 brain。

复算使用新输出目录，避免覆盖证据：

```text
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-08/map-05-run-1 --out <新的评测目录>
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-08/map-05-run-1 --out <新的离线回放目录>
```

所有指标的输入文件 SHA256 位于 `run-metrics.json`，评测器自身 SHA256 位于 `report/evaluation.json`，冻结源码逐文件证明位于 `source-commit.json`。前七局原始报告及运行索引条目保持不变。
