# 第十局：首球有效送达，重复选择受阻出口后正常停止

结论 **FAIL，完成 1/2 个红球交付**。第 25 轮新版 pick 抓取首球，第 42 轮 place 通过观测判断并返回道路；独立评测确认首球交付事件有效、最终仍在目标存放区内。随后探索连续重复同一出口，7 次移动为零；评测侧正常停止保存证据。第二球未抓取、未送达，map-05 尚未通过，十布局未开始。

[独立报告](report/REPORT.md)、[机器可读指标](run-metrics.json)、[原始 brain 日志](map-05-run-1/brain/)保留本局全部结论。数字由导出日志复算，评测真值未提供给运行中的 brain。

## 可复算指标

| 项目 | 本局结果 |
|---|---:|
| 决策轮数 / 模型调用 | 55 / 58 |
| 模型调用耗时合计 | 1325.0591091650003 秒 |
| 仿真用时 / 终点 tick | 228.98 秒 / 11449 |
| 观测 / 已写入 motion 行 | 287 / 178 |
| pick 动作 / grab 请求 / 成功抓取身份 | 1 / 2 / 1 |
| place 动作 / release 请求 / 有效交付身份 | 1 / 1 / 1 |
| 失败轮数 | 14：13 次动作返回失败，1 次外部停止后执行失败 |
| 模型传输错误 / 状态校验错误 | 3 / 0；传输错误全部恢复 |
| brain bridge 请求 / 非白名单请求 | 1328 / 0 |
| 原生审计拒绝请求 / 已接受非白名单请求 | 0 / 0 |

未触及 200 轮和 1200 秒仿真上限。模型耗时是 `llm.jsonl` 所有 `elapsed_s` 合计，包含重试；brain 墙钟为 1469.321803375 秒，均不能与仿真时钟混用。第 55 轮失败的 take_exit 未写入成功的 motion 行，其请求及异常仍在 bridge 和轮次日志内。

## 首球观测、抓取、交付时间线

| 事件 | 轮 / 观测或 tick | 仿真时间 |
|---|---|---:|
| 首球首次原始观测，WM 身份 `target_024` | r14 / obs58 | 47.34 秒 |
| 首球首次 CONFIRMED | r20 / obs85 | 69.12 秒 |
| 第二球首次原始红球观测 | r22 / obs98 | 81.72 秒 |
| 第一次 grab 后仍未持球 | r25 / obs112 | 88.42 秒 |
| 第二次 grab 原生成功事件 | r25 / tick4496 | 89.92 秒 |
| 首次持球传感器观测 | r25 / obs115 | 90.20 秒 |
| 5 次后退后复核原位置为空，标记 HELD | r25 / obs120，最终 obs121 | 93.40 秒 |
| 首球原生 `package_delivered` 事件 | r42 / tick10111 | 202.22 秒 |
| release 后夹爪为空 | r42 / obs232 | 202.64 秒 |
| 后退取得唯一球在区内像素见证，记为 DELIVERED | r42 / obs233 | 205.32 秒 |
| 返回道路完成，place 成功 | r42 / obs237，最终 obs238 | 209.34 秒 |

第 25 轮首次 grab 失败后前进 6 cm、转向约 -4.4804°再 grab 成功。第一次 grab 的新鲜视觉距离为 26.1360 cm、WM/里程计距离 21.0566 cm；第二次 grab 使用已确认位置结合里程计的近场模式，距离 15.0686 cm、方位 -0.0196°，当时没有直接新鲜目标检测。两类依据分别记录，不将 WM 距离冒充视觉距离。

抓取后 motion 67–71 为 **5 次各 6 cm 的 backward**，合计命令 30 cm，每一步后观测都在道路上且保持持球。obs120 的 `old_position_matches=0`，pick 返回 `grasp_observed`；`road_return` 为 `already_on_observed_road`。这证明本次正常抓取路径通过，不证明未在本次触发的失败恢复分支也已实测通过。

第 42 轮 place 有 18 个 motion：12 次对准（7 次 forward、5 次 turn）、release、backward 25 cm，以及 4 次返回道路的 forward。全局 13 个离路观测均在这一轮，最后 obs237 恢复 `onRoad=true`；首球的交付成功与暂时离路、归路过程均保留。唯一当前像素见证 `ball_track_id=null`，本局没有实际创建 delivery alias，不能声称有新轨迹的 alias 分支经过本局实测。

独立评测最终 tick11449：首球交付事件未撤销、未持有，最终位置到目标区中心距离 0.5118968508 场景单位，小于原生半径 0.95。第二球没有抓取或交付事件、最终不在区内；虽然有原始红球观测，严格同帧身份核验没有为其建立稳定 WM 绑定或确认。brain 还保留未确认的 `target_048` 历史；不能仅凭红色类别把它擅自等同于第二球或新增一个真值球。

## 第 43 轮把受阻返回解释为下一路口成功

第 43 轮 `explore(exit_angle=-102)` 调用 take_exit，motion155 返回：

```text
accepted=true, stoppedBy=front_clearance, distanceCm=8.7, elapsedTicks=70
```

obs239（209.34 秒）和 obs240（210.74 秒）都为 `atNode=true`，但动作返回 `success=true, reason=next_junction_observed`。冻结提交 `27d3a4eb3eed854d8101c837bbaf3aafa2e09f18` 的 `autonomous_brain/actions.py:222` 先判断 `atNode && distanceCm >= 0.2`，第 224 行提前报告成功；`front_clearance` 分支在第 228 行，未被执行。因此这次受阻返回被当作下一路口成功，且成功 evidence 未保留 actuator_result；原始 motion 行仍完整保留。

这是执行器结果与冻结动作分支的具体矛盾，不能混入独立 evaluator 仅针对 pick/place 的真值 Judge 假阳性计数。报告在 `run-metrics.json` 的 `logged_action_result_contradictions` 单独记录 1 条，不改变原动作日志。

## 七次零进展出口选择和扫描证据

第 43 轮前车头 169.6°、相对出口 -102°，折算绝对出口为 67.6°。第 43 轮后车头变为 -145.2°，当前唯一报告的相对出口为 -147.2°，折算后仍是 **67.6°**。随后 7 次 take_exit 都使用该相对角度，朝向、位置、tick 均未变化：

| 轮 | 模型 explore 参数 | motion 行 | 前 / 后观测 | 返回距离 / tick |
|---:|---|---:|---|---|
| 44 | `exit_angle=-147.2` | 156 | 242 / 243 | 0 cm / 0 |
| 46 | `exit_angle=-147.2` | 161 | 251 / 252 | 0 cm / 0 |
| 47 | 空参数，由控制器选择出口 | 162 | 254 / 255 | 0 cm / 0 |
| 49 | `exit_angle=-147.2` | 167 | 263 / 264 | 0 cm / 0 |
| 50 | 空参数，由控制器选择出口 | 168 | 266 / 267 | 0 cm / 0 |
| 52 | `exit_angle=-147.2` | 173 | 275 / 276 | 0 cm / 0 |
| 53 | 空参数，由控制器选择出口 | 174 | 278 / 279 | 0 cm / 0 |

各次返回均为 `front_clearance`，观测中当前车头 -145.2°、前方余量 0.1 cm，脑返回 `selected_exit_blocked`。两次 take_exit 之间的扫描仍让仿真时钟推进，不能将整个阶段描述为“仿真时间没有前进”。

第 45、48、51、54 轮 look_around 中，obs247 / 259 / 271 / 283 分别在 213.02 / 217.58 / 222.14 / 226.70 秒观测到：车头 **34.8°**、`onRoad=true`、前方余量 **292.4 cm**、相对出口 **32.8°**。每次四视角扫描结束又回到 -145.2°、前方余量 0.1 cm，随后继续同一出口命令。原始位置一直为 rightCm=93.6、forwardCm=0.4，移动距离计数为 1552.1 cm。

证据支持的是“当前朝向下的出口执行未能先产生转向/平移，失败反馈与下一次选择没有打破循环”。反向余量大是另一方向存在可观测空间的证据，**不证明该方向必能完成规划路线，也不支持所有物理道路均不可达**。没有执行的替代动作不能被写成已经验证的成功方案。

## 正常停止与模型错误分开

[evaluator-stop.json](evaluator-stop.json) 记录评测侧在 `2026-09-25T09:56:28.043Z`、tick11449 设置既有停止标志。第 55 轮模型正常输出 `explore(exit_angle=-147.2)`，其 take_exit 随后收到 NOT_RUNNING，brain 原样记录 `BridgeError: take_exit: NOT_RUNNING`。driver 正常导出、`status=complete`、`sourcesUnchanged=true`；brain 子进程退出码 1，任务保持 FAIL。末轮是外部停止后的执行异常，不是模型请求失败。

3 次模型传输错误均恢复：调用16 HTTP502 → 17，调用27 URLError → 28，调用45 HTTP502 → 46。没有 JSON/状态校验错误；55 次决策加 3 次传输重试，共 58 次调用。

独立 pick/place Judge 有 2 次一致、假阳性 0、假阴性 0、不可判定 0，其他 53 次动作不在此真值 Judge 范围。第 43 轮的日志矛盾另行记录。已确认红球误差统计为 30 个逐观测样本：平均 1.974752 cm、RMSE 2.020529 cm、最大 2.232640 cm，未匹配确认样本 0。重复 WM 估计计为重复观测样本，不等于 30 次独立定位。

## 归档与复现

- [source-commit.json](source-commit.json)：7 个 brain 文件和 driver 共 8 个文件的冻结 Git 字节 SHA256，均匹配启动 manifest、结束 manifest 和适用的 brain summary。完整前后 manifest 相等；平台、采集函数记录哈希前后不变。未用后续工作树修复替代本局源码。
- [archive-integrity.json](archive-integrity.json)：4 个 gzip 均读取到 EOF，压缩/展开字节数及 SHA256 与 `evidence.json` 一致。record 为 **63,949,789 字节（60.987271 MiB）**，展开 92,574,471 字节，低于 100 MiB，不分片、不重新压缩。
- [llm-replay/README.md](llm-replay/README.md)：55/55 轮、58/58 调用严格离线重放一致，原始模型状态直接使用，全部记录耗尽，除 mode 外完整记录一致；网络调用 0、环境读取尝试 0、原证据未变。这不是全仿真重放，也不是双球任务通过。
- evaluator v2 确认最终 sample tick = simulationEndTick = 11449；首球有效送达、第二球未送达，最终在道路上且空夹爪，但没有成功 done。任务门槛未放宽，真值仅用于导出后的独立评测。

复算采用新目录，避免覆盖：

```text
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-10/map-05-run-1 --out <新的评测目录>
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-10/map-05-run-1 --out <新的离线回放目录>
```

所有输入 SHA256 见 `run-metrics.json`，评测器自身哈希见 `report/evaluation.json`，前九局保留核验见 `archive-checks.json`。原报告、失败结论和索引条目未改，本归档没有修改源码、提交或推送。
