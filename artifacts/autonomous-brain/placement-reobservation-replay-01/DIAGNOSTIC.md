# 放置复观测回放诊断01 — 输入匹配通过，未获得独立新球见证

本次是降低至75轮上限的本地机器人回放诊断，**不是新的真实模型正式试验，不计入LIVE_RUNS或任务成功局**。输入为Run14前75个决策、90条模型调用的原始前缀，未改写状态、请求、响应或历史错误。没有调用新的模型API。

结论分开保留：**严格输入/记录回放PASS，完整导出PASS；r75放置复观测仍失败；任务评测FAIL。** 两球在原生记录及终端真值中实际有效交付2/2，但第二次place仍未观察到独立的新球见证，目标保留RELEASED_UNVERIFIED，随后达到75轮诊断上限，没有done。既不把两球实际送达当自主完成，也不把回放匹配当修复已在真实场景奏效。

| 指标 | 本诊断结果 |
|---|---:|
| 决策 / 消耗记录调用 | 75 / 90 |
| 新模型API调用 | 0 |
| 实际brain墙钟时间 | 225.965441375秒 |
| 原Run14保留的模型elapsed累计 | 3144.6570466709986秒，非本次模型耗时 |
| 仿真 / 观测 / motions | 453.22秒 / 578 / 428 |
| 动作失败 / 执行异常 / 外部停止错误 | 14 / 0 / 0 |
| bridge调用 / 非白名单请求 | 2741 / 0 |
| 已完成新增视点 | 1，实际沿路15.940812099047601cm |
| 第二视点 | 未执行；道路方向筛选停止 |
| 独立有效交付 / 观测成功place | 2 / 1 |
| 最终sample tick / record结束tick | 22661 / 22661 |
| 上限与结束原因 | 75轮 / 1200仿真秒；round_limit |

动作共38次explore、21次look_around、11次go_to、3次pick、2次place。前缀保留12次历史传输错误与3次历史状态校验错误及恢复过程；它们不是此次发生的网络故障。8次grab、2次release是此次机器人桥执行记录；target_029两抓，target_115跨两次pick六抓。

## r75实际执行与边界

release仍发生在obs555→556，夹爪由持物变空，释放边界frame556、435.98秒；preexisting身份为022、029、092。退后25cm后的初始判断obs557、438.66秒仍只有已送达旧029，candidate_witnesses=0、placement=null。

修复首先沿原放置轨迹返回，obs571、447.08秒onRoad=true，road_return=returned_to_observed_road。随后实际新增6个动作：

1. obs571→572转136.9°，朝向从−173.8°变为−36.9°。
2. obs572→576连续4次请求forward4cm；每次均有新观测、onRoad=true，实测累计15.940812099047601cm。
3. obs576→577转−149.06015463210372°朝已观察的绿色区域，最终朝向174.1°，453.22秒。

obs577仍只有一个红检测，track_id与known_delivered_object_id均为target_029，reason=matches_verified_placement，raw48cm；没有额外的新球见证。该视点的old_objects_reobserved=true，但candidate_witnesses=0、placement=null。因此“旧球仍可辨”和“额外新球出现”两个要求并未同时满足，不能据旧球再次出现认定115送达。

随后第二视点前返回viewpoint_road_direction_not_observed。此时公开道路数据onRoad=true、atNode=false、headingErrorDeg=−18.3°；与174.1°朝向合成的切向为155.8°/−24.2°，最近方向与上次行进方向−36.9°相差12.7°，超过该版本10°方向延续筛选。因此第二视点没有移动，不能写成32cm或两视点已全部执行，也不能从这个筛选停止推断所有物理道路不可通行。

最终结果after/post_observation=577，final_observation=578。obs577中的115仍是本次release尚未最终判定时的HELD内存；动作结束后的obs578明确为RELEASED_UNVERIFIED/pending，029为DELIVERED。完整轨迹、道路观测、红球及绿色区域检测见diagnostic-metrics.json。没有对原像素、旧身份排除或释放边界门槛作放宽。

## 独立评测与失败解释

本诊断导出的record显示两球交付事件均未撤销，终端sample与endtick同为22661，两球最终都在存放区内且未夹持，独立有效交付2/2。评测仍FAIL：round_limit_reached、brain_did_not_finish_with_observed_done、terminal_done_not_corroborated及execution_or_controller_error。

最后一项是评测器对brain status=failed/round_limit的通用标签；本局envelope的controllerErrors为空，执行异常轮数0、外部停止0，没有NOT_RUNNING。不能把这个标签误写成导出故障、模型网络失败或评测方提前停止。原生run_finished不替代自主done。

Judge在**本诊断**的5个pick/place中为4次一致、1次假阴性（r75）、0假阳性、0无法核验，其他70轮不在抓放对照范围。这与Run14原评测的几何绑定覆盖不同；原正式局的2次unverifiable及其报告保持原样，不用本次新导出的几何证据倒改旧结论。逐球首次视觉、确认、原生抓取/交付时间、位置误差及失败动作完整保存在report/。

## 严格匹配与源码证明

prefix-replay-proof.json验证：前缀恰是Run14 decision_index≤75的90条原始字节；75个模型输入状态、75个输出动作与原Run14完全一致；实际消耗的90条完整调用记录除mode从live变为replay外完全相同，全部耗尽，未提前发生输入mismatch。机器人传感器和record则是本次真实本地执行产生的新证据，不是复制Run14原生记录。

冻结提交553f5ef3783a29f46556cbe54ec1d060cb90fd4d的七个brain文件与driver共8文件，其Git字节哈希和运行前/后manifest、brain自记哈希完全一致；driver sourcesUnchanged=true。证明不用修复后的工作树替代已运行源码。平台与capture前后哈希一致。

模型API调用0由冻结replay分支、driver的replay调用路径及90条mode=replay严格匹配共同佐证；本地机器人桥HTTP不属于模型网络。独立离线转录复核再次通过75轮/90调用，网络入口调用0、环境读取尝试0。回放保留的历史elapsed及transport_error字段不代表新增API消耗。

## 完整导出与无损分片

driver status=complete，export-status.complete=true，record/samples/sensorAudit/captures/envelope五项完成，failures=[]、partial={}。四份gzip读至EOF验证CRC、长度、压缩及展开SHA256；envelope长度与哈希也与evidence.json一致。原始brain与导出文件字节保持。

record原gzip为133,102,067字节，超过100MiB；按50MiB原始压缩字节分为52,428,800、52,428,800、28,244,467字节，没有解压重压。完整SHA256：

```text
522817087316dbb3f64dea4ad1620bb3af1f0c5ffec5473284b751d1dc8bacf7
```

原件仍保留本机，只对这个精确路径忽略Git；分片已在隔离临时目录恢复并逐字节及整份SHA核验，临时副本已清理。恢复与离线复算：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/placement-reobservation-replay-01/record.chunks/manifest.json
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/placement-reobservation-replay-01/map-05-run-1 --out artifacts/autonomous-brain/placement-reobservation-replay-01/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/placement-reobservation-replay-01/map-05-run-1 --out artifacts/autonomous-brain/placement-reobservation-replay-01/recomputed-replay
```

输出目录必须尚不存在；独立评测退出码1表示完整FAIL报告。archive-integrity.json记录四份gzip及envelope的全部字节/哈希和恢复校验；source-commit.json保存8文件证明；archive-checks.json保存原件不变及LIVE索引不变证明。本诊断不更改正式运行索引、Run14历史报告、fix报告或当前交付文档。
