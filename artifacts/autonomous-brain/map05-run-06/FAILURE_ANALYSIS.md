# map05-run-06 失败分析

正式结论：**FAIL**。本局确认并抓住了首个红球，但没有执行 place 或 release，也没有交付。评估方针对已经观察到的导航循环及未被控制/决策消费的新鲜停靠证据请求停止；本局没有达到轮数或仿真时间上限。所有已记录的循环均被动作步数上限结束，模型随后曾改选 explore 并继续前进，不能将这些问题描述成全局永久阻塞。

冻结源码提交为 `ffeacc9a597d4d523ec1a98066e6dfa04ff081f2`，driver 记录 `sourcesUnchanged=true`，全部 brain / driver 文件与冻结提交的字节核验通过。依据为 `artifacts/autonomous-brain/map05-run-06/summary.json` 与 `artifacts/autonomous-brain/map05-run-06/source-commit.json`。本文不包含之后修复版本的运行结论。

## 正式指标与停止原因

| 指标 | 最终记录 |
|---|---:|
| 轮数 | 46 |
| 模型调用数，含重试 | 49 |
| 模型累计调用耗时 | 878.071511461 秒 |
| 仿真时间 | 567.38 秒 |
| 观测数 | 386 |
| motion 记录数 | 295 |
| 已抓住的任务红球 / grab 调用 | 1 / 2 |
| place / release / 有效交付 | 0 / 0 / 0 |
| 最终夹爪 | holding=true |
| 记录为失败的动作 | 10 |

200 轮 / 1200 仿真秒上限均未达到。模型累计调用耗时不是仿真时间。46 轮动作组成是 explore 26 次、look_around 10 次、go_to 9 次、pick 1 次；全部 386 个观测均为 onRoad=true。

`artifacts/autonomous-brain/map05-run-06/evaluator-stop.json` 记录评估停止时间为 `2026-09-25T07:05:48.916Z`，tick 28369，原因为 `observed_route_oscillations_and_unconsumed_fresh_standoff_evidence`。随后 driver 正常导出。r45 的最后有效动作到 obs384；r46 的 explore 在 obs386 后请求 follow_road，收到 `NOT_RUNNING`，最终脑错误为 `BridgeError: follow_road: NOT_RUNNING`。最后一条 motion 仍属于 r45。该终止错误发生于评估方停止后，不能被写成一次自主导航运动失败。

正式结果来源：`artifacts/autonomous-brain/map05-run-06/report/REPORT.md`、`artifacts/autonomous-brain/map05-run-06/report/evaluation.json`。10 个失败动作包括 r8 已返回路口的道路受阻、8 次 go_to 失败，以及停止后的 r46 错误。

## 已完成的确认、导航与抓取

首个红球 WM 轨迹 `target_018` 在 r12 obs47 首次有效入库，仿真 38.24 秒。扫描完成后返回该观测的实际 heading -21.8°。独立观测位点 obs47、77、86 满足原确认门槛，r20 obs86 在 69.14 秒确认目标。

新提示在本局有直接行为证据：确认后的下一轮 r21 立即选择 `go_to(target_018)`。motions49–55 依次转向 180°、沿路走 20cm 和 5.4cm、转向 35.882°，再前进 10cm、10cm、7.827cm。obs97 的新鲜目标检测距离为 39.4074cm、方位 -2.2773°，成功通过原 25–40cm / ±10°停靠门槛。该动作没有出现原地反复转向，证明此前首路点修复在这条真实目标路线生效。

r22 的两次抓取必须按不同证据时间区分：

| 证据 | 仿真时间 | 结果 |
|---|---:|---|
| 第一次 grab 后，obs102 / motion59 | 80.24 秒 | holding=false |
| 再前进 6cm，obs103 / motion60 | 81.20 秒 | holding=false |
| 离线原生 package_grabbed 事件，tick4084 | 81.68 秒 | 抓取事件，身份仅由离线报告核验 |
| 第二次 grab 后，obs104 / motion61 | 81.96 秒 | 首次传感器 holding=true |
| 后退 30cm，obs105 / motion62 | 85.16 秒 | holding=true，原位置无对应球检测，标记 HELD |

因此不采用 83.16 秒作为首次抓取时间：原生事件为 81.68 秒，脑首次读到持球为 81.96 秒，脑完成抓取后复查为 85.16 秒。r22 最终结果为 `grasp_observed`；后退期间仍在路上。此后至最终观测始终持球，未执行任何释放动作。

## 导航回归一：新中间路口导致 A↔C 重规划循环

r23 执行 `go_to(storage-zone_028)`，从 obs107 的 85.16 秒运行至 obs157 的 230.80 秒，耗费 145.64 仿真秒，最后返回 `remembered_route_did_not_reach_target`。

使用冻结版本 RoadMemory 对实际 odometry / road 观测顺序做只读重建，可复现下列首路点选择；重建不读取地图或真值：

| 位置 | 里程计 right / forward，米 | 重建路线的首个有效路点 | 实际选择 |
|---|---|---|---|
| A，obs125、127、…、155 | -1.177 / 0.498 | 旧路点 B=(-1.090, 0.121) | 相对方向 162.495°，选择出口 -180°，实际到 C |
| C，obs126、128、…、156 | -1.086 / 0.335 | A=(-1.177, 0.498) | 相对方向 -174.226°，选择出口 171.6°，返回 A |

旧图保留了已走过路段的 A–B 长边；本次在该路段方向上提前观察到 C 后，C 没有作为 A–B 连续路径的中间点。每步重新规划时，C 的已记录路径先返回 A，A 再指向 B，动作执行却又到 C。motions80–111 为 32 个约 31.3cm 的出口动作，obs125–156 构成 16 对 A/C 终点；目标记忆距离仅在 277.3639cm 与 264.2403cm 间变化。持球及在路状态始终成立。

这是实际位置循环，不是推测的路线风险，也不是此前“取最后路点”的同一实现错误。r24 改选出口 66.6°后离开该循环并继续前进，说明动作内循环被上限结束后模型能够恢复。

后续修复应验证动作内保留既定下一路点，避免中途到新节点就丢失原有路线进度。例如保留 B 时，C→B 的方向与传感器出口 -25.7°接近。此为只基于传感器的修复方向，不是已运行通过的结果。仅凭新节点接近旧长边的几何投影便拆分边，会在弯道、平行道路或交叉但不连通的道路上引入错误连接，不应被当成已有拓扑事实。

## 导航回归二：已知路线耗尽仍向目标选出口

r28 执行相同绿色区目标的 go_to，obs176–223，仿真 245.40–377.00 秒。obs179 位于 (0, 0.024m)，重建 route_to 只返回已知最近路点 (0,0)，而目标仍远于停靠范围。动作把“没有剩余路点”回退成“直接朝目标方向”，在该节点选择唯一出口 179.2°返回 (0,0.25m)。在那里新一轮 route_to 又指向 (0,0)，于是选择 -180°回去。

motions125–167、obs179–222 记录了该往返；后续固定选择 179.7°与 -180°，每次出口动作约 27.4cm。动作最终因 45 步上限失败。r29 选择 explore 出口 0.8°后离开，继续探索。r31 又一次 go_to 在相同两端往返，obs231–279、motions171–217，耗费 130.94 仿真秒；r32 改选 explore -90°后继续前进并接近绿色区。

“已到已知道路上离目标最近的点”并不证明已知道路能够到达目标。应验证路线耗尽但未达到视觉停靠条件时返回明确的需探索结果，并以短周期无进展检测提前结束重复动作，而非持续回退到目标方向。这些是后续验证要求，不代表本局已实现。

## 导航回归三：近目标路口连续零位移

r44 执行 `go_to(storage-zone_050)`。到 obs336 时，位置为 right72.4cm / forward27.7cm，heading -92.5°，atNode=true，目标记忆距离 49.1302cm、方位 42.6020°；可选出口为 55.7°、-103.4°、-180°。

冻结动作的路口出口分支要求 remaining>60cm，近场前进分支要求 abs(bearing)<=40°。这里两个分支都不匹配，落入 follow_road；该接口在路口立即停止。**motions250–293 共 44 次**请求 follow_road 16.1302cm，均返回 `stoppedBy=junction, distanceCm=0, elapsedTicks=0`。obs337–380 均为同一 pose、tick28143、仿真562.86秒。最后仍只返回通用的 `remembered_route_did_not_reach_target`。

r45 改选 explore 出口 55.7°后走了 40.6cm+20cm，说明外部仍存在可执行出口。该缺陷是近目标但不能直进时的路口分支缺口及零进展检测缺失，不是环境无路可走。

## 停靠不一致与下一状态缺失依据

四次 go_to 都因为新鲜视觉证据不满足原停靠范围而失败。拒绝成功判定是正确的；控制缺口在于到达记忆停靠范围后未继续使用新鲜视觉修正，反复调用会重复相同失败。

| 轮 / 依据观测 | 请求目标 | 最终 WM 距离 / 方位 | result 中新鲜检测距离 / 方位 |
|---|---|---|---|
| r33 / obs288 | storage-zone_005 | 36.9521cm / -0.9839° | 20.8108cm / -16.0719° |
| r35 / obs298 | storage-zone_050 | 32.0452cm / 0.0626° | 24.4818cm / 1.4101° |
| r37 / obs306 | storage-zone_050 | 32.0452cm / 0.0626° | 24.4818cm / 1.4101° |
| r39 / obs317 | storage-zone_005 | 32.9990cm / -0.0650° | 19.3756cm / -10.6436°，检测 track_id 为 storage-zone_050 |

r37 没有任何 motion，仿真时间不变：记忆距离已在范围内，极小的记忆方位误差不产生转向，新鲜距离仍低于 25cm，于是原样失败。r39 请求对象与检测 track_id 不同，表中保留两者，未将不同绿色区轨迹自行合并或赋予真值身份。

冻结 Runtime 的对象表只向模型提供 WM 记忆距离 / 方位；recent_actions 仅含 round、action、success、reason、after_observation。下一轮的模型状态没有收到 result 中的新鲜距离 / 方位。可直接对比 rounds35 的 result 与 rounds36.state.recent_actions，以及 rounds37 与 rounds38：24.4818cm 的依据在日志内存在，但没有传给下一次决策。

后续应验证在原 25–40cm / ±10°范围内闭环修正，同时将有界、明确标注观测编号的新鲜动作依据传入下一状态；新鲜检测不得覆盖或冒充 WM 记忆字段。不能通过放宽成功阈值、只修改提示或声称未执行的 place 成功来解决。本局始终没有 place，故没有验证之后放置修复的效果。

## 证据索引与离线评估边界

以下均为仓库相对路径。rounds / observations 的物理行号分别与 round / observation_index 相同；motions 行号为本文件上文所用编号。

- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/brain/rounds.jsonl`：r20–23、28–39、44–46 的状态、模型动作与结果。
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/brain/observations.jsonl`：obs47、77、86、97、101–106、125–128、155–156、179–182、220–222、288、298、306、317、336–380、386。
- `artifacts/autonomous-brain/map05-run-06/map-05-run-1/brain/motions.jsonl`：49–62 抓取前后；80–111 的 A/C 往返；125–167 的路线耗尽往返；250–293 的零位移；294–295 的恢复动作。
- `artifacts/autonomous-brain/map05-run-06/navigation-regressions.json`：紧凑的传感器回归案例、数值、行号与尚待验证的预期行为。

离线报告唯一绑定 `target_018` 至 guangyang-target-1，首次看到38.24秒、确认69.14秒、原生抓取81.68秒，最终仍被夹持且没有交付。报告还唯一绑定 `target_046` 至 guangyang-target-2，首次原始检测为 r31 obs235 / 391.54秒，未确认、未抓取。身份对应仅用于结束后的评估，不参与上述在线路线分析。

离线定位统计包含18个已绑定的 CONFIRMED 轨迹观测样本，平均误差1.851299cm，RMSE1.924000cm；另有1个确认轨迹观测无法计入。重复位置估计也计为样本，不应视作18个独立测量。来源为 `artifacts/autonomous-brain/map05-run-06/report/evaluation.json`。

离线模型记录重放为46/46轮、49/49调用匹配，网络调用0次、环境读取尝试0次。它只验证记录与模型输出校验，不执行动作、不重放全仿真，也不改变本局FAIL。范围说明和逐轮结果分别位于 `artifacts/autonomous-brain/map05-run-06/llm-replay/README.md` 与 `artifacts/autonomous-brain/map05-run-06/llm-replay/replay-checks.json`。

本局的确定进展是确认后立即导航、真实接近目标和两次尝试后的持球核验。确定缺口是持球后的已知路线进度、路线耗尽、近目标路口处理、视觉停靠修正及下一状态证据传递。后续源码修复与测试属于独立工作，本分析不声称它们已在本局运行或通过。
