# Run13 失败分析 — 已确认历史LOST仍待完成，评测方停止

本局独立评测为 **FAIL，有效交付0/2**。没有grab或release调用，原生记录也没有抓取或交付事件。driver v5完整导出，record/samples/sensorAudit/captures/envelope五项全部完成，无导出failures。

停止原因来自公开传感记录和独立离线反例：target_047曾CONFIRMED，随后在obs293被归档为LOST，仍永久保留为待完成义务；冻结WorldModel只关联活跃轨迹，归档身份没有重获路径。离线同位置重新获得三个独立位置确认的反例揭示该义务无法被新轨迹完成解除。**不能据此声称本局target_077与target_047是同一物理目标，也不能把离线反例当作本局已发生的重获。**

评测方在tick12304请求stopRequested，末轮r58 look_around之后的turn收到NOT_RUNNING。evaluator v3将此轮单独归为external_stop；它不是模型请求失败、模型自主完成或到达轮数/时间上限。envelope中1条同tick NOT_RUNNING与停止相符；这是停止后的控制错误，导出本身仍成功。

| 指标 | 复算结果 |
|---|---:|
| 轮数 / 模型调用 | 58 / 69 |
| 模型累计请求耗时 | 1497.3446953300001秒 |
| brain墙钟用时 | 1678.4929227090001秒 |
| 仿真 / 观测 / motions记录 | 246.08秒 / 365 / 250 |
| 动作失败 / 模型执行错误 / 外部停止错误 | 6 / 0 / 1 |
| 抓取 / 放置 / 有效交付 | 0 / 0 / 0 |
| 传输错误 / 状态校验错误 | 4 / 7，均重试恢复 |
| 最终sample tick / record结束tick | 12304 / 12304 |
| 配置上限 | 200轮 / 1200仿真秒，均未达到 |

动作选择共35次explore、22次look_around、1次go_to；58轮最终都有模型动作。传输错误为1次RemoteDisconnected与3次HTTP502，校验错误均为go_to requires a CONFIRMED object；完整call索引、重试和时间见run-metrics.json。模型耗时为llm.jsonl各elapsed_s之和，不含重试等待或动作用时。

## 只使用brain记录的关键时间线

| 事件 | 轮 / 观测 | 仿真秒 | 可核查事实 |
|---|---|---:|---|
| target_047首次入库 | r26 / obs163 | 107.66 | TENTATIVE，hit_count=1 |
| 第二个独立命中 | r36 / obs222 | 155.32 | TENTATIVE，hit_count=2 |
| 第三个独立命中，首次确认 | r43 / obs263 | 179.66 | CONFIRMED，hit_count=3 |
| target_047开始STALE | r44 / obs274 | 189.14 | ever_confirmed=true |
| go_to道路接近被拒 | r44 / obs275 | 190.06 | final_approach_requires_road_reposition；permitted_cm=0 |
| target_047归档LOST | r47 / obs293 | 203.90 | confidence=0.11024281917124795，仍pending |
| target_077首次入库 | r52 / obs328 | 225.70 | 新TENTATIVE轨迹，hit_count=1 |
| target_077第二命中 | r56 / obs358 | 243.86 | hit_count=2，仍未CONFIRMED |
| 最后公开观测 | r58 / obs365 | 246.08 | holding=false；047仍LOST/pending，077仍TENTATIVE |

047最后一次计入确认的观测为179.66秒，之后其三个命中及存储位置没有被新的视角伪装为更新。最终待完成列表为target_045、target_047、target_077；另有3个未确认历史假设已退役，18个记账路口、27个未探索出口。这里的轨迹ID只是brain身份，不是物理目标ID。

六次动作失败如下，末轮停止错误另列：

| 轮 | 动作 | 原因 |
|---:|---|---|
| 13 | explore | road_blocked_returned_to_junction |
| 21 | explore | road_blocked_returned_to_junction |
| 22 | explore | road_blocked_returned_to_junction |
| 41 | explore | road_blocked_returned_to_junction |
| 44 | go_to(target_047) | final_approach_requires_road_reposition；heading_error=88.2°，右侧余量0.1cm，允许直行0cm |
| 46 | explore | road_blocked_returned_to_junction |
| 58 | look_around | turn: NOT_RUNNING，external_stop |

失败动作完整传感依据与before/after观测索引保存在report/evaluation.json，不将道路受阻归因为所有物理道路都不可达，也不声称重获缺陷是未交付的唯一物理原因。

## 独立评测与身份边界

evaluator v3直接检查本局record中的交付/撤销事件及最终位置：两个目标均无有效交付事件，最终均在存放区外且未夹持。终端sample与endtick相同，record完整；这些结论不依赖driver的success布尔值。

几何匹配可唯一对应的第一颗目标首次原始视觉为r2/obs5（2.76秒），无CONFIRMED；第二颗目标首次原始视觉为r16/obs102（59.84秒），首次确认记录为r43/obs263（179.66秒）。没有任何目标的抓取或交付时间点。WM首次入库不替代原始首次看到。

评测器在逐帧几何候选关系中列出047与077，但这不构成跨时刻物理身份相同的独立证明；本归档不以它为身份合并或停止原因的论据，真值不会送入brain。只有已确认轨迹观测参与位置误差：样本11，平均误差与RMSE均13.295977278019818cm。11是重复保存状态的观测样本数，不是11个独立确认视角；位置误差仅报告，不作为新增成功门槛。

Judge eligible=0，match/假阳性/假阴性/unverifiable均0，58轮全部不在pick/place对照范围。零分歧不代表explore等动作已经获得真值正确性证明。

## 导出、重放与冻结源码

record为91,263,056字节，展开130,103,923字节；原始gzip低于100MiB，无需切片。SHA256：

```text
357102e59fb5cefb73e0b8cf601c2dd2ed50641c7e52185a25740eabfb9f597f
```

四份gzip读至末尾通过CRC/长度/压缩及展开SHA256核验，envelope字节哈希匹配evidence.json。冻结提交885c24f8d2b58870fe42c42d434610f9dab96a27的七个brain文件和driver，共8文件，与前后manifest及brain自记哈希完全一致；sourcesUnchanged=true，平台/capture前后哈希相同。没有使用后续修改的工作树来代替冻结源码证明。

严格离线LLM重放PASS：58/58轮、69/69调用，包括恢复后的模型输出及停止后的动作执行失败，完整记录除mode外一致且全部耗尽。网络调用0、环境读取尝试0、原始日志不变。重放不是全仿真重放，也不替代任务验收。

本局brain保存1712条bridge调用，非白名单请求0；record记录拒绝调用0、非白名单已接受调用0。完整原始证据在map-05-run-1/；独立评测见report/，逐球时间线与失败动作完整保留。

指标及输入哈希见run-metrics.json，8文件字节证明见source-commit.json，压缩包校验见archive-integrity.json，前12局条目与36份旧报告保留证明见archive-checks.json。Run11缺失导出的限制不被本局数据替换。停止证据evaluator-stop.json与原始CDP响应按原字节保留。
