# 阶段一 · round 2：FAIL

2026-09-23 19:48:32–20:48:21 AEST，赛题2 map-01…map-10 各执行一局。十局全部结束后才进行本轮诊断；冻结检查全部为 true。31 次分配中执行 10 局、运行前跳过已完成布局 21 次，没有执行后重跑或择优替换结果，未运行赛题1。

**本轮确认且抓到 8/10 个布局；按本轮目标日志合并为 9 个独立场景，成功 7/9 = 77.8%，低于 80%（需至少 8/9）。阶段一 round 2 判定 FAIL。** 程序错误 0/10、实际原地重复 observe 0、guard 违规 0，视觉与固定规则门槛通过；这些通过项不抵消独立场景成功率失败。

仅 01/03 的投放前目标轨迹相同，必须合并。未抓到的两个独立场景为 07（暂定命中无法确认，也无法关联真球）和 09（E 已确认、道路记忆接近失败）。旧 v28r1 六组只保留保守对照：4/6 = 66.7%，不替代本轮分母。阶段一已消耗两轮，最多还可完整运行一轮；阶段二至五未启动。根阶段总 SUMMARY 待第三轮完成后统一编写。

## 冻结版本与运行前检查

| 项目 | 值 / 证据 |
|---|---|
| 程序版本 | `wm-stage1-r2-20260923` |
| 冻结源码 | [program.py](program.py) |
| 原始文件 SHA256 | `e6706b31f9a719aeaa0af556598869afdca393fda9b101ba86519880c0fc29a1` |
| 平台 trim 后执行文本 SHA256 | `3d8b05db01bdc5a00c48741efb7c014995420ef95f4d471942cb864ba28eb62c` |
| wm_kit 提交 | `ad237a143f0d35e100a28c15567d4b75bd56cccf` |
| 嵌入包 SHA256 | `651a89967b41aad583b70e5f5095c5fc35f6babc950d8ab878748cb69e9f66e3` |
| 包一致性 | [wm_identity.json](wm_identity.json)：14 个 Python 文件均等于该提交 |
| 指定 pylint 检查 | [pylint.txt](pylint.txt)：E1123/E1120/E1121/E0633/E0602 零报错，平台注入 robot 声明为内建 |
| 回归测试 | [tests.txt](tests.txt)：105 passed，无 skip/xfail |
| 坐标静态扫描 | [static_coordinates.json](static_coordinates.json)：程序和 14 个嵌入文件，748 个数值字面量，成对违规 0；单值近似仅供人工复核，不冒充坐标违规 |
| 批跑中代码冻结 | [code_manifest.json](code_manifest.json)、[freeze_verification.json](freeze_verification.json)：所有受检源码、driver、runner、评测工具及冻结副本一致 |
| 原始数据复核 | [numeric_diagnostics.json](numeric_diagnostics.json)：146 项一致性检查全部通过，无缺失完整性证据；十局 lines/record/samples 均等于原始 attempt 副本 |

十局 `program_version` 的程序、wm_kit 提交和嵌入包哈希全部一致。完整平台记录均为 `program_finished`，没有 `program_error`。日志主动报告的任务失败仍按任务失败计算；不会因为正常退出就变成抓取成功。

本轮改动、阈值来源及源码差异见 [CHANGES.md](CHANGES.md) 和 [changes.patch](changes.patch)。导航查询缓存、道路图记忆接近与明确的任务失败出口是本轮变更；窗口、三次命中、15cm 间距、末点 0.5m、30cm 记忆行驶、0.25m/单步 approach 等门槛未放宽。1000 次导航查询及 300 次道路控制来自平台公开 API 硬上限，不是按布局拟合。

## 逐局结果

误差及抓取真值单位为 cm，侧向向右为正。只有最终 WM 到真值红球 ≤30cm 才填写 A–G；该关联由离线 driver 真值判定，编号不进入机器人程序。`mission` 是平台子任务完成数，既不是抓到球数，也不是投放球数。前向/侧向是成功抓到那次的真值，所有抓取尝试另见 [batch_report.json](batch_report.json)。

| 布局 | 球 / 标定 | 确认 | WM 最终误差 | 抓取次数 | 抓到瞬间 前向/侧向 | mission | 结束 / 失败数值 |
|---|---|---|---|---|---|---|---|
| 01 | B / 已用于模型选择 | 3/3 | 2.5 | 3 | 11.4 / +1.2 | 0/13 | 抓到；送货 `release_sample` 请求 110/80/140cm 均在 junction 移动 0cm，`flow_end=false` |
| 02 | C / 已标定 | 3/3 | 5.4 | 2 | 12.5 / +2.8 | 3/13 | 抓到并投放一个目标；approach 前纯记忆 1304.2cm、WM 0.220m，`flow_end=true` |
| 03 | B / 已用于模型选择 | 3/3 | 2.5 | 3 | 11.4 / +1.2 | 1/13 | 抓到并投放一个目标；`flow_end=true` |
| 04 | C / 已标定 | 3/3 | 2.7 | 2 | 16.3 / +2.4 | 3/13 | 抓到并投放一个目标；approach 前纯记忆 517.3cm、WM 0.218m |
| 05 | C / 已标定 | 3/3 | 2.4 | 2 | 16.4 / +2.0 | 2/13 | 抓到并投放一个目标；approach 前纯记忆 2715.8cm、WM 0.219m |
| 06 | D / 已标定 | 3/3 | 8.2 | 2 | 11.8 / −4.7 | 3/13 | 抓到；送货 40 次 `delivery_take_exit` 后节点重规划耗尽；central-north 上 40.6cm 入路、11.3cm 遇 front_clearance，`flow_end=false` |
| 07 | 无对应真球 / 不适用 | tentative 1/3 | — | 0 | — | 0/13 | `all_viewpoints_tried_or_unreachable`；最终候选 0、hit=1；最近真球 86.5cm，超过关联 30cm；确认失败 |
| 08 | C / 已标定 | 3/3 | 2.6 | 3 | 10.9 / +2.0 | 1/13 | 抓到并投放一个目标；approach 前纯记忆 1932.0cm、WM 0.220m |
| 09 | E / 未见过 | 3/3 | 10.3 | 0 | — | 2/13 | `memory_graph_exhausted`；记忆行驶 3291.8cm，最后 WM 0.653m > 进入 fine 所需 0.30m；没有 approach/grab |
| 10 | D / 已标定 | 3/3 | 3.7 | 2 | 13.5 / +2.1 | 0/13 | 抓到；送货与 06 同类重规划耗尽，40.6cm 入路→11.3cm front_clearance；`flow_end=false` |

抓取成功的 8 局都通过 WM 关联与实际被抓目标同一性检查，全部抓取事件均与同 tick 真值样本精确对齐。总抓取动作 19 次；成功时刻为 01/03 tick 2607、02 tick 12232、04 tick 6246、05 tick 21620、06 tick 4442、08 tick 16545、10 tick 2806。完整抓取真值包含被判 `far` 的尝试，没有只留下成功尝试。

送货流程实际成功 5/10（02/03/04/05/08）。01/06/10 抓到了球但送货失败；它们符合本阶段“确认且抓到”的成功定义，送货失败仍如实保留。`full_targetDelivered` 十局均为 false，不能把单球流程成功写成整场任务完成。

## 本轮独立场景与分组证据

使用冻结评测脚本对本轮目标事件重新分组：从首个 WM 命中前的 observe 开始，没有 WM 时才从首个红球检测开始；至投放开始前结束。去绝对 tick、目标 ID、蓝球与前期巡逻，保留目标读数、位姿、确认决策和接近轨迹。容差未修改：距离 3cm、相对坐标 3cm、方位 2°、置信度 0.05、相对 tick 2；类别和计数要求相同，组内所有成员两两相符。

| 本轮组 | 成员 / 真球关联 | 结果 | 证据 |
|---|---|---|---|
| S01 | 01、03 / B | 成功 | 293 个归一目标事件完全相同；SHA256 `736e39583cdb81d7d75aec116eef2a0b73f9bcee3f1a285e1f16e267a457d123` |
| S02 | 02 / C | 成功 | 936 个目标事件，确认读数 63/77/51cm；图接近与其他 C 布局不同 |
| S03 | 04 / C | 成功 | 352 个目标事件，确认第三点 73cm，末点 WM 0.787m |
| S04 | 05 / C | 成功 | 599 个目标事件；与 04 的事件数量、路径决策不同，不能合并 |
| S05 | 06 / D | 成功 | 349 个目标事件，确认读数 73/63/55cm |
| S06 | 07 / 无对应真球 | 失败 | 852 个目标事件，最终 tentative 1 hit，无法建立有效球关联 |
| S07 | 08 / C | 成功 | 544 个目标事件；与 05 不同，归一第 402 项 direction 为 +1 而 05 为 −1（类别/计数容差 0） |
| S08 | 09 / E | 失败 | 1017 个目标事件，已确认后道路图接近失败；不能沿用旧轮“伪检测场景”作为本轮目标关联 |
| S09 | 10 / D | 成功 | 308 个目标事件，确认读数 87/73/42cm；与 06 首次距离差 14cm >3cm，第一 WM 相对 x 差 0.604401m >0.03m |

旧六组对照保持所有成员：01/03、02、04/05/08、06/10 本轮均成功；07 和 09 失败，故 4/6。旧组中的 04/05/08 与 06/10 本轮目标轨迹已经不等价，不因都成功而合并。完整差异路径、归一数据及原始行索引在 [stage_report.json](stage_report.json)；抽取摘要在 [numeric_diagnostics.json](numeric_diagnostics.json)。

## 失败位置的具体证据

以下行索引为各 `map-XX.json` 中 `lines` 数组的 **0 起始索引**，不是文本文件行号。

**07：不是没有 WM，也不是 API 预算耗尽。** 第 5969 项第一次报告 `all_viewpoints_tried_or_unreachable`，hits=0；继续巡逻后，第 6002 项 observe（tick 12957）看到两条红色检测：100cm/−26.14°/0.87，以及 88cm/−23.53°/0.80。后一条在窗口内，第 6005 项产生 `target_001` tentative、hit=1、WM=(1.271,0.613)m，距最近真球 86.5cm，因此报告为“无对应真球”，不把该距离归入 E/G 测试误差。第 6851 项候选数量 0，第 6852 项确认失败仍 hits=1，第 6854 项正常结束，导航查询 477、道路控制 121。

07 共 47 次 observe、55 次 viewpoint_selected、53 次 viewpoint_failed：24 次窗口内无同轨迹命中、21 次 unreachable、8 次无新的观测运动；另有 6476 个候选拒绝日志。`no_new_observation_motion` 是规划阶段拒绝该候选的记录，不是实际重采；实际 `observe_motion_violation` 和原地 observe 均为 0。平台结束 tick 13694、273.9s。原生帧图像与像素检测重算已证实：88cm/−23.53°和同帧100cm/−26.14°两条来自粉红导航地标。证据见 [VISION_FINDINGS.md](VISION_FINDINGS.md) 与 vision_focus_cases.json。

**09：E 的定位和接近结果必须分开。** 第 698 项确认同一 `target_001`，三次记录为 87/60/66cm，采样两两最小间距 0.2452529307m，末点 WM 距离 0.7582534541m。最终 WM 到 E 的真值距离 10.3cm（第一 WM 为 12.5cm），关联在 30cm 内成立。之后没有任何 observe，177 次图候选选择、71 次 frontier 步进、42 次 unreachable；其中 25 次 `stopped_before_candidate:junction`、9 次 `transition_approach:front_clearance`、5 次 max_distance、2 次 front_clearance、1 次不同过渡节点。

09 第 1039 项明确 `memory_graph_exhausted`，位于 central-south、onRoad=true，当前 WM 距离 0.653m，大于进入细接近的 0.30m；第 1040 项累计记忆行驶 3291.8cm、reached=false。第 1041 项 `flow_end=false, stage=grab`，查询 831/1000、道路控制 294/300，仍余 169 次查询和 6 次道路控制，故停止原因不能写成 API 预算耗尽。没有 approach，也没有 grab，相关调用前约束保持 unknown。平台结束 tick 27332、546.6s。

**01/06/10：单列送货失败，不能隐藏。** 01 的 release_sample 110/80/140cm 三次均移动 0cm，停于 `node:north-west-main:start`；06/10 送货多次回到 central-north，路口状态进度 43.5cm，入路后进度 34.1cm，前方受阻后进度 22.8cm、frontClearanceCm=0.3。最后按明确任务失败收口，没有平台程序错误；这表示错误门槛通过，不能解释为送货问题已修复。

## 预算与固定规则

| 布局 | observe / 92 | 视觉 bytes / MiB | 导航查询 / 1000 | 道路控制 / 300 | 固定规则审计 |
|---|---|---|---|---|---|
| 01 | 7 | 2,165,140 / 2.0648 | 140 | 38 | 全部 pass |
| 02 | 7 | 2,239,794 / 2.1360 | 444 | 161 | 全部 pass |
| 03 | 7 | 2,209,021 / 2.1067 | 127 | 34 | 全部 pass |
| 04 | 9 | 2,654,863 / 2.5319 | 286 | 104 | 全部 pass |
| 05 | 9 | 2,786,125 / 2.6571 | 716 | 261 | 全部 pass |
| 06 | 10 | 3,040,700 / 2.8998 | 425 | 161 | 全部 pass |
| 07 | 47 | 10,017,975 / 9.5539 | 477 | 121 | 未确认 / 未 approach 项 unknown；全程道路及预算 pass |
| 08 | 9 | 2,789,706 / 2.6605 | 608 | 214 | 全部 pass |
| 09 | 12 | 2,811,086 / 2.6809 | 831 | 294 | approach 前三项 unknown；其余 pass |
| 10 | 8 | 2,439,301 / 2.3263 | 381 | 151 | 全部 pass |

- 125 次实际 observe 均保留红蓝原始读数及 tick；重复 observe=0、guard 违规=0。每局最大 47≤92。视觉预算按原始 `record.vision.frameBytes` 计算，最大 10,017,975 bytes=9.5539MiB≤20MiB；总量 33,153,711 bytes 是十局合计，不拿合计与单局 20MiB 门槛比较。
- 9 局达到确认，均为同一轨迹 3 次命中，原始读数 42–87cm，所有两两位姿间距≥15cm；最紧为 10 的 0.1507348666m。末点最短为 01/03 的 0.5533803362m≥0.5m。07 未确认，相关项 unknown，不写成 pass。
- 8 局实际调用 approach，各 1 次、`max_steps=1`、WM 距离 0.218–0.221m≤0.25m。调用前纯记忆行驶最短 10 的 38.7cm≥30cm；02/04/05/08 虽然都成功，但行驶 1304.2/517.3/2715.8/1932.0cm，不能把通过门槛等同于路径高效。图段累计与最终 approach 前距离分别保留，细步前进/后退后的最终值才用于门槛。
- 十局完整 `run_finished` 的 off_road episodes/durationMs/maxSeverity 均为 0，显式 onRoad=false 为 0；全程在路上通过。
- 总门槛已包括“全部局固定规则不得 fail”及“确认且抓到的局固定规则必须全部 pass”。两项均通过。07/09 的未进入阶段 unknown 仍保留，既不伪装通过，也不额外更改原有 80% 成功率定义。

完整固定规则逐条证据见 [STAGE_REPORT.md](STAGE_REPORT.md)。本轮所有程序错误、道路和预算结论均基于完整运行记录，不因抓取阶段结束而忽略后续送货。

## 未见位置精度与已知未知

E 有 **1 个独立有效样本**：09，最终误差 **10.3cm**，确认成功但未抓到。G 有 **0 个有效样本**，无可报告测试误差。07 的 WM 未关联任何真球，86.5cm 只作失败诊断，不算 E 误差，也不记作 0。B/C/D 的误差只报告，不用于未见位置泛化结论。

上述 E 精度是“WM 在 30cm 内成功关联”的条件精度，不是全体目标召回率或无条件精度；单样本不能证明整体泛化达标。[视觉核验](VISION_FINDINGS.md) 已完成125/125次observe的原始查询、日志、PNG及精确renderTruth绑定和像素检测重算；141张原生PNG哈希、计数、字节全部一致。记录1帧应见未见、5帧伪红候选。map-07 tick3778的应见未见图像显示遮挡，不能将其替代旧v28r1 tick1929缺失的原帧；旧tick1929具体原因仍未知。

## 离线复现与下一步边界

新增 [extract_round_diagnostics.py](../../../../tools/extract_round_diagnostics.py) 只读已完成的原始日志和现有报告，生成带原始索引、SHA256、预算、停止原因及完整性核验的 [numeric_diagnostics.json](numeric_diagnostics.json)。可从仓库根目录重复执行，不启动仿真：

```text
PYTHONDONTWRITEBYTECODE=1 python3 tools/extract_round_diagnostics.py artifacts/inloop/stage-1/round-2
```

提取器在 round 1/2 原始产物上交叉核验通过；旧轮缺失的导航用量保留 null，不编造为 0。现有 batch_report/stage_report、机器人程序、driver 和 raw trial 均未由本次报告工作修改。

本 SUMMARY 明确阶段一第二轮 **FAIL** 后，才能依据两个独立失败场景开展第三轮；本阶段最多三轮，第三轮仍需冻结同一代码完整跑十局。不能为达到 80% 放宽分组容差、删掉 07/09、扩大关联半径或放宽固定规则。阶段二及后续阶段尚未开始，不能算作完成。
