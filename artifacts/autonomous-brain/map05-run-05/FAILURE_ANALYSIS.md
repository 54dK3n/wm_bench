# map05-run-05 失败分析

正式离线评估结论：**FAIL**。本局没有抓取或交付，未完成任务；评估方因独立复现的动作源码缺陷请求停止，待模型请求结束后由 driver 正常导出。本局从未执行 `go_to`、`pick` 或 `place`，因此不能把独立测试中的 `go_to` / `place` 缺陷写成本局实际触发的失败。

本文的行为分析依据已冻结的传感器、里程计、WorldModel、模型及动作日志。真值身份与最终交付结论仅引用结束后的离线报告，不用于解释在线决策或推断可行路线。链接均相对本文所在目录；源码路径如出现则相对仓库根目录。

## 正式结果与停止边界

| 指标 | 最终记录 |
|---|---:|
| 轮数 | 42 |
| 模型调用次数，含传输重试 | 47 |
| 模型累计调用耗时 | 919.20992771 秒 |
| 仿真时间 | 147.52 秒 |
| 观测数 | 177 |
| 抓取 / 有效交付 | 0 / 0 |
| 记录为失败的动作 | 5 |
| 源码在运行期间保持不变 | `sourcesUnchanged=true` |

冻结提交为 `329b40721544365182a60b814b120466371bc0e5`。[source-commit.json](source-commit.json) 确认全部 brain 与 driver 文件字节匹配该提交；[summary.json](summary.json) 保存正常导出及源文件核验结果。200 轮 / 1200 仿真秒上限均未达到；模型耗时不是仿真耗时。

[evaluator-stop.json](evaluator-stop.json) 记录停止请求时间为 `2026-09-25T06:41:08.078Z`，当时 tick 为 7376。停止原因是 `offline_action_regressions_require_fix_before_grasp_validation`，其独立证据为 [before.json](../action-safety-fix-20260925/before.json) 和 [before-tests.txt](../action-safety-fix-20260925/before-tests.txt)。停止记录明确声明：这些离线缺陷不代表本次实跑触发了 `go_to` 或 `place` 缺陷。

第 41 轮动作已返回路口，观测 176 的 tick 为 7376。第 42 轮仍完成了待处理模型决策，随后 `take_exit` 返回 `NOT_RUNNING`，脑记录终止原因为 `BridgeError: take_exit: NOT_RUNNING`。最后一条 motion 属于第 41 轮，第 42 轮没有新增运动记录。因此该终止错误是外部停止后的结果，不能作为自主导航永久卡死的证据。

正式 FAIL、每球离线时间线及最终位置核对见 [REPORT.md](report/REPORT.md) 和 [evaluation.json](report/evaluation.json)。四次道路受阻后返回路口也计入失败动作，另一次为上述停止后的第 42 轮错误；“失败动作数 5”不等于五次不可恢复故障。

## 已确认红球与任务策略

`target_021` 的三次有效独立观测发生于 obs53、obs77、obs92，分别对应 r13、r18、r22。原始距离 / 方位分别为 `73cm / 0.41°`、`52cm / 29.79°`、`51cm / -5.09°`。r22 的 obs92 在仿真 71.82 秒将其确认为 `CONFIRMED`；绿色区 `storage-zone_005` 同帧确认。

r13 的完整四向扫描记录了 `reobservation_candidate`：目标 `target_021`、观测 53、实际 heading `-21.8°`、道路朝向误差 `0°`、前方净空 `76.5cm`。扫描后返回该朝向；同位置复看没有增加独立 hit。这说明朝向保留补救在真实传感器回合中执行，确认门槛没有被放宽。

从 r23 到 r41，共 **19 个已经结束的回合**，每轮输入状态都含 `CONFIRMED target_021`，但动作全部是 **16 次 explore + 3 次 look_around**。这 19 轮包含已恢复的道路受阻，并非全部动作都返回 success。期间没有一次 `go_to`、`pick` 或 `place`，所有观测的 holding 都为 false；最终该目标仍为 CONFIRMED、7 hits。r35–37 的输入状态中，它的记忆距离曾为 37.8cm、37.8cm、33.6cm，但方位仍为 46.8°、46.8°、71.0°，不能将这些距离直接视为已具备抓取条件。

可证实的策略现象是：已有确认任务目标和确认存放区后，模型仍持续探索，未进入搬运阶段。日志没有模型解释，不能进一步断言模型这样选择的内在原因。现有提示要求继续探索未知出口，但没有明确规定空爪且存在可服务的已确认任务目标时何时优先处理它。后续应验证任务推进优先级；本局不能证明 `go_to` 或抓取链路正确或错误。

证据：[rounds.jsonl](map-05-run-1/brain/rounds.jsonl) 第 13、22–41 行；[observations.jsonl](map-05-run-1/brain/observations.jsonl) obs53、77、92、164、176。上述 JSONL 的物理行号分别与 round / observation_index 一致。

## 第二个红球类别候选：两次 hit 后失去跟踪

这里的“第二候选”专指 WM 轨迹 `target_046`，不代表已证明是第二个真实红球。离线评估只唯一绑定了 `target_021` 与 `guangyang-target-1`；`guangyang-target-2` 没有绑定到任何 WM 轨迹。不得把 `target_046` 的时间线替代第二个真值球的时间线。

| 轮 / 观测 | 传感器与里程计证据 | WM 结果 |
|---|---|---|
| r33 / obs142 | raw77cm，bearing -33.29°；位置 right -118.1cm / forward 150.4cm | 首次有效入库，TENTATIVE、hit1 |
| r34 / obs145 | follow_road 16cm；两观测位点直线间隔 15.94cm；raw78cm / -28.74° | 第二个独立位点，hit2 |
| r35 / obs151 | 与 obs145 同位置；raw55cm / -35.09°，超出原始 ±35°视角门槛 | 未送入 WM；原地观测本来也不能成为第三个独立位点 |
| r36 / obs154 | 到附近路口；raw52cm / -27.89°有效，但距 obs145 仅 7.52cm | 刷新 last_seen，未达到原 15cm 位点间隔，仍 hit2 |
| r37 / obs157 | take_exit 一次走 40.6cm 后才观察；没有任何红球检测；记忆位置预计 45.79cm / -0.12° | 3.14 秒漏检，置信度 .751700→.176152，STALE、hit2 |
| r39 / obs165 | 转向后记忆位置预计 43.19cm / 25.92°；仍无红球检测 | 置信度 .098384，LOST、hit2 |
| r41 / obs176 | 未再次取得该轨迹的有效观测 | 仍为 LOST、hit2 |

原始感知窗口是 `40cm <= raw_distance < 90cm` 且 `abs(raw_bearing) <= 35°`；独立 hit 还要求与已接受位点至少相隔 15cm。以上现象均与原门槛相符。冻结版本的 WM 对视野内预期可见但漏检的目标采用 1.5 秒半衰期：`.751700 × 0.5^(3.14/1.5) = .176152`，低于 STALE 阈值 .50；后续低于 LOST 阈值 .15。该变化有源码与观测依据，不是提前计数或任意失效。

动作采样存在可定位的覆盖缺口：r34 的普通 follow_road 采用 16cm 步长；r36 到路口后，r37 的 take_exit 仍一次移动 40.6cm 才产生下一次观测。16cm 规则没有覆盖出口动作。可建议后续让出口移动也具备有界间隔的传感器观测，但现有日志不能证明这 40.6cm 中间一定存在合格的第三个视点，也不能证明当前传感器状态构成永久阻塞。不能据此降低确认门槛、扩大原始感知窗口或进行真值导航。

证据：[observations.jsonl](map-05-run-1/brain/observations.jsonl) obs142、145、151、154、157、165、176；[motions.jsonl](map-05-run-1/brain/motions.jsonl) 第 78、83、84 行，分别是 r34 的 16cm follow_road、r36 的路口停止、r37 的 40.6cm take_exit。

## 道路恢复与网络重试

r9、r31、r32、r41 遇阻后均通过转向 180°、沿已走道路分段 follow_road 返回路口。r31 与 r32 重复进入同一受阻方向，但 r33 换出口后继续前进，没有形成持续闭环。r41 的恢复可直接复查：obs172 受阻，obs173 转向，obs174 沿路 20cm，obs175 再走 11.9cm 到路口。全部 177 个观测均 `onRoad=true`；最终里程计累计距离为 1136.4cm。

47 次真实模型调用中，5 次传输错误分布于 4 个决策，均在 v7 允许的最多两次瞬态重试内获得有效输出；没有 JSON 校验错误。42 个成功响应保留了 SSE `[DONE]`，失败传输记录没有 action。末次成功输出发生在已请求停止的决策 42，动作执行随后收到 NOT_RUNNING，不能算作模型传输失败。

| 决策轮 | 调用序列 | 恢复结果 |
|---:|---|---|
| 20 | call20 HTTP502 → call21 retry1 | explore 已执行 |
| 24 | call25 URLError → call26 retry1 HTTP502 → call27 retry2 | explore 已执行 |
| 41 | call44 HTTP502 → call45 retry1 | explore 已执行并完成道路恢复 |
| 42 | call46 HTTP502 → call47 retry1 | 输出有效；执行因评估停止返回 NOT_RUNNING |

证据：[rounds.jsonl](map-05-run-1/brain/rounds.jsonl) 第 9、31–33、41–42 行；[motions.jsonl](map-05-run-1/brain/motions.jsonl) 第 91–94 行；[llm.jsonl](map-05-run-1/brain/llm.jsonl) 对应 call_index 的同号行。

离线模型记录重放为 **42/42 轮、47/47 调用完全匹配，网络调用 0 次、环境读取尝试 0 次**。该结果只验证模型记录和重试流程可重放，不执行动作，不重放全仿真，也不改变本次 FAIL。[重放范围说明](llm-replay/README.md)、[逐轮核验](llm-replay/replay-checks.json)。

## 离线评估所能补充的结论

结束后的离线报告唯一绑定 `target_021` 至 `guangyang-target-1`，首次看到为 obs53 / 42.8 秒，首次确认为 obs92 / 71.82 秒。对该已绑定确认轨迹的 86 个观测样本，位置平均误差为 2.353264cm，RMSE 为 2.597156cm；重复未更新估计也计入样本，不能把样本数理解为独立测量数。

报告在 obs96 / r23 / 74.34 秒唯一对应到 `guangyang-target-2` 的原始检测，但没有为它建立唯一 WM 轨迹绑定，也没有确认、抓取或交付证据。本文不以传感器候选的空间接近代替身份对应。

下一次验证应在单独提交修复、冻结源码后进行：先处理已有独立测试证实的动作缺陷，再验证已确认目标的搬运优先级与出口移动的观测覆盖。本局提供了成功的首次红球确认、在路恢复和网络重试证据；它没有提供任何真实抓取或放置链路的执行证据。
