# 放置前选点回放诊断01 — 后验见证成功，整体仍为轮数上限FAIL

本次是降低至75轮上限的本地机器人回放诊断，**不是真实模型正式试验，不计入LIVE_RUNS或任务成功局**。输入是Run14前75个决策、90条模型调用的未改写前缀；没有新的模型API调用。

**严格输入/记录匹配PASS，放置前选点及后验见证诊断PASS，完整导出PASS；整体任务评测仍FAIL。** r75在释放前选择公开观测支持的另一瞄准位置，释放后同帧分别看到旧已送达球与额外新球，原严格门槛接受唯一新球见证。原生记录与终端真值也确认有效交付2/2。但诊断在75轮上限结束，没有执行自主done，不能把这次修复验证当正式任务成功。

| 指标 | 本诊断复算 |
|---|---:|
| 决策 / 已消耗模型记录 | 75 / 90 |
| 新模型API调用 | 0 |
| 实际brain墙钟时间 | 208.288669791秒 |
| 回放保留的原模型elapsed累计 | 3144.6570466709986秒，非新增模型耗时 |
| 仿真 / 观测 / motions | 437.88秒 / 552 / 402 |
| 动作失败 / 执行异常 / 外部停止错误 | 13 / 0 / 0 |
| bridge调用 / 非白名单请求 | 2611 / 0 |
| grab / release | 8 / 2 |
| 观测成功place / 独立有效交付 | 2 / 2 |
| 最终sample tick / record结束tick | 21894 / 21894 |
| 结束原因 | round_limit，降低至75轮诊断上限 |

动作共38次explore、21次look_around、11次go_to、3次pick、2次place。90条记录仍包含12次历史传输错误和3次历史状态校验错误及恢复过程，不能当作本次发生的网络故障。target_029两次grab；target_115在两次pick中共六次grab；与Run14相同的历史模型决策驱动了这次真实本地机器人执行。

## r75选点与后验判定

选点来源是**obs545，432.14秒**，当时持有target_115，画面中已识别旧已送达target_029。记录的source_region为当前公开检测storage-zone_056，bbox=(182,251,306,56)，四边在画面内。选中的像素为**(u=258.5,v=279)**，即该框左四分之一横向位置与中间纵向位置；其内椭圆归一化平方为0.25，小于原0.64边界。占用排除依据是该帧公开红球、蓝球和障碍框，不是平台真值或堆叠参数。

该像素通过公开相机参数与当前里程计投影成固定地面瞄准点，position_m=(1.0935653843669173,−0.04538468963219805)。瞄准点是从bbox推断出的候选位置，单凭选点并不证明真实空闲或交付；最后必须重新观察球与完整绿色区域。

实际放置轨迹为一次转向7.446482457271031°，然后三次forward7cm。到obs549时，固定瞄准点与当前里程计给出的距离18.677922560268815cm、方位−0.20388209390191037°满足原19cm/3°对准门槛。这不是新的绿色中心测距；release_aim.last_alignment明确记录basis=fixed_observed_ground_point_and_current_odometry。

release发生在obs549→550，释放边界frame550、435.20秒，夹爪变空；预存身份仍为022、029、092。再后退25cm，在**obs551、437.88秒**取得放置依据，onRoad=true且holding=false。同一帧有两个分离红框：

- 新候选框(278,208,78,64)，raw35cm，track_id=None，reason=outside_demo_memory_window；没有旧已交付身份标签。它与完整绿色框(265,249,269,42)形成唯一合格的新球见证，candidate_witnesses=1。
- 旧球框(424,206,66,54)，raw42cm，明确识别为known_delivered_object_id=target_029，继续按原规则从新球候选中排除。

新候选使用现有近场像素放置见证通路，未把raw35cm帧伪造为WorldModel确认命中，也未绕过释放边界、旧身份排除、唯一性或像素门槛。新旧框在同帧分别可见，不能把旧球框重复计算为第二球。

r75返回success=true、reason=ball_observed_in_storage；placement.frame_id=551，ball_track_id=None合法；after/post_observation=551，final_observation=552。最终obs552中029和115均为DELIVERED，两个未确认LOST旧假设仍按原记录退役，公开pending为空。退后已在道路上，road_return=already_on_observed_road，没有额外归路动作，也未触发v16放置后补充换位分支。

选点源帧、原bbox、选中像素、投影位置、最后对准及同帧新旧检测均由release-aim-proof.json按本诊断日志核对；完整轨迹与逐帧道路、夹爪和检测在diagnostic-metrics.json。诊断证明本次确定场景中的后验见证有效，不代表模型自主探索和完整任务已经完成。

## 原生交付与独立Judge

原生第一球未撤销交付事件为tick11022、220.44秒；第二球为tick21739、434.78秒。事件发生在release动作内部，早于frame550的435.20秒后观测和frame551的437.88秒视觉验证。终端sample与record结束tick均为21894，两球最终在存放区内且不被夹持，独立有效交付2/2。

本诊断Judge覆盖5个pick/place，5次一致、0假阳性、0假阴性、0无法核验；其余70轮不在抓放对照范围。位置误差为82个可唯一对应的CONFIRMED状态观测样本，均值6.020970889323964cm、RMSE6.577160269360222cm、最大8.050884221966683cm；样本数不等于独立确认视角数，误差仅报告。原Run14及前一次诊断的失败/歧义结论保持不变，不能用本次证据倒改旧报告。

独立评测仍列round_limit_reached、brain_did_not_finish_with_observed_done、terminal_done_not_corroborated和execution_or_controller_error。最后一项是评测器针对brain status=failed/round_limit的通用标签：本诊断controllerErrors为空、执行异常0、外部停止0，无NOT_RUNNING。不能将其写成模型网络故障或导出失败。75轮是本诊断降低的上限，正式上限仍为200轮/1200仿真秒。

## 严格回放、冻结来源及导出

prefix-replay-proof.json确认所用前缀恰好是Run14 decision_index≤75的90条原始字节。75个模型输入状态、75个输出动作均与Run14一致，90条实际消耗记录除mode由live变为replay外完整相同，记录全部耗尽，没有提前mismatch，包括第一次place后的后续输入匹配。后续发生变化的是第75个模型动作内部的新放置执行；诊断没有第76个决策，不能声称已回放其改变后的未来模型状态。

本次传感器和record由新的本地执行产生，没有复用Run14原生导出。冻结提交9b2cc8486ec9b870cf1219b977ea36387565331a的七个brain文件与driver共8文件，Git字节哈希均匹配运行前/后manifest及brain自记SHA；sourcesUnchanged=true，前后完整manifest相等。证明不依赖后续工作树源码。

模型API调用0由冻结replay分支、driver的replay调用路径及90条mode=replay完整匹配佐证；本地机器人桥HTTP不属于模型网络。独立离线转录复核75轮/90调用PASS，网络入口调用0、环境读取尝试0。3144.6570466709986秒是原Run14历史elapsed保留值，不能当本次模型耗时或新API消耗。

driver status=complete，五项record/samples/sensorAudit/captures/envelope导出完整，failures=[]、partial={}。四份gzip读至EOF校验CRC、压缩及展开长度和SHA，envelope长度/SHA与evidence.json一致。所有原始日志与导出文件保持原字节。

record原gzip为128,929,981字节，超过100MiB；按50MiB连续原始压缩字节分为52,428,800、52,428,800、24,072,381字节，没有解压重压。完整SHA256：

```text
9016f23998dfddd0e1260fab69ce19a68d701d45671f24fdba49586ff62617e2
```

原件保留本机，仅该精确路径忽略Git；分片已在隔离临时目录恢复并逐字节及整份SHA比较，临时副本已清理。仓库根目录复算：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/release-free-point-replay-01/record.chunks/manifest.json
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1 --out artifacts/autonomous-brain/release-free-point-replay-01/recomputed-report
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/release-free-point-replay-01/map-05-run-1 --out artifacts/autonomous-brain/release-free-point-replay-01/recomputed-replay
```

输出目录必须尚不存在，评测退出码1表示完整FAIL报告。archive-integrity.json保存全部压缩/展开哈希及恢复验证，source-commit.json为8文件Git证明，archive-checks.json证明原件和正式LIVE索引未改。本归档未读取Run15活记录，未修改CURRENT/docs/fix报告、正式索引或源码。
