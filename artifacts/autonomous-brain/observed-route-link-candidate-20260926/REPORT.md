# 已观察有向行程候选（仅 artifact）

此候选只新增旁路证据与只读提示，未接入生产，也未执行动作。基于冻结 commit `6ee4abf464504eb297242df98dc9fadaaf7debfa` 的 navigation v4，保留其全部节点/出口/访问/完成/阻挡记账。15 cm、5°、15°、45°规则与 done 条件未改。查询不会清 U，也不宣称相似节点是同一个物理路口。

## 冻结与验证

- [baseline_navigation.py](baseline_navigation.py)：SHA256 `3238323babe95ac32cf45e6ce833ecba32857dd31a247b78ee5495ba768a7981`。
- [candidate_navigation.py](candidate_navigation.py)：SHA256 `8449018d1e318639ca6eb51c5f053cff9d0e5185785b4d1de3f06402a0362795`。
- [test_candidate.py](test_candidate.py)：SHA256 `7d3f37ab054180ed6cc7a002d17bffa845e6c18deb828308dff3f01b7bcc334d`；26 tests PASS。
- [recompute.py](recompute.py)：SHA256 `c37a6bfdb0955b4481e608c3d170a11397ca597f3793962a380e4811de147a53`；离线复算 PASS。
- 命令及退出码：[execution.json](execution.json)。测试输出：[tests.stdout.txt](tests.stdout.txt)、[tests.stderr.txt](tests.stderr.txt)。复算输出：[recompute.stdout.txt](recompute.stdout.txt)、[recompute.stderr.txt](recompute.stderr.txt)；结构化同副本：[findings.json](findings.json)。
- 公开输入来源/hash：[input-manifest.json](input-manifest.json)、[run20-input-manifest.json](run20-input-manifest.json)。只使用原 review 固定公开快照，以及已结束 Run20 的 brain observations/rounds/motions；未读取 truth/layout/driver/env，未联网。

## 数据和调用顺序

旧调用 `update(odo, road)` / `chosen(odo, angle, blocked=False)` 原语义保持；没有索引不会补造锚点。

新增可选 `observation_index`，以及：

```python
memory.update(odo, road, observation_index=i)
memory.chosen(odo, chosen_fresh_angle, observation_index=i)
# 保留每条连续公开 observation，及每次真实 motion 的原结果；跨 action/round 也保留。
memory.update(next_odo, next_road, observation_index=i + 1)
anchor = memory.observation_anchor(i + 1)  # 深拷贝；历史身份不被后来更近节点改写。
result = memory.record_completed_traversal(observations, motions)
hints = memory.frontier_hints(odo, road, observation_index=i, limit=3)
```

最小 observation 是 `{observation_index, odometry, road}`；odo 必须含有限的 rightCm/forwardCm/headingDeg/distanceCm/tick。可携带 `observation:{frameId,tick}`，提供后整个窗口均验证同 tick、不同 frame。motions 使用现有公开形状 `{method,params,actuator_result,before_observation,after_observation}`。起点必须是 indexed chosen 的唯一 fresh 出口，并与首个真实 take_exit 参数一致。take_exit/follow_road 要求原结果 accepted=true；turn/forward/backward 按原结果 completed=true。collision/wrong_way/front_clearance/off_road、拒绝、错误、缺失/非有限/下降里程、离路、漏 motion、非连续索引均拒绝。

窗口第一次短 take_exit 后仍在原 node 时调用者继续等待，不能把临时 `no_distinct_node_arrival` 当完整行程；首次真正不同 observed node 才提交，观察离开后回原 node 则停止该窗口。观测间无 motion 必须位置、朝向、distanceCm、tick 完全不变，允许新增 frame 的静止 look。抓放、新 departure、阻挡或离路应取消旁路窗口。候选不连接 runtime，因此上述收集钩子仍须集成者实现，不能从 legacy completed/active_exit 推断成功。

路径长度只用 departure→arrival 的公开 distanceCm 差；弦长仅做里程一致性下界检查，不当实际路径长度。只记真实方向；反向须独立真实走过。记录保留出发 fresh heading、完整原 motion、全窗口必要里程证据及两端锚点。

## 查询规则

1. 当前 fresh 中存在未完成且未阻挡出口时，只给这些出口（最多 3）。
2. 否则只能串接明确完成的有向行程。当前点→记录出发点、每段到达→下一段出发，必须 node id 相同、公开位置完全相等、整个同帧 absolute 出口集合在 5° 内双向唯一匹配。不能仅凭同桶、弦方向、无向 breadcrumb 或相似外观补连。
3. 第一出发方向必须唯一匹配当前真实 fresh 出口；提示使用其当前原始相对角。断连/歧义无结果。
4. 终点出口还需自己的历史 anchor 与完整 fresh 上下文相容，沿用原 15 cm 局部范围；同时明确给出 actual arrival anchor、该出口 anchor 与 gap，始终要求到达后重新观察。gap 不是隐含走过的一段，也不是出口已到达或已完成的证明。

`traversal_records()`、`exit_observation_anchors()`、`observation_anchor()` 和 hints 都返回深拷贝。26 项测试涵盖旧 v4 字段全等、真实 primitive 字段、单向无反向、优先 fresh、3 上限、断连/歧义/消失、混桶上下文、精确位置拼接、终点 gap、无动作完成证据、错误/离路/缺里程/漏观测、深拷贝及后来近节点不改历史锚点。

## 历史公开反例

- Run18 与 Run19 的 obs1→2：均提供完整原 take_exit 结果、连续公开观测、两端不同 observed node，真实里程 25 cm；两例均成功建立有向记录。
- Run18 r126/obs851：弦推得相对角约 −58.2436°，当前 fresh 无匹配；r109/obs737 的真实 departure 则对应 r126 fresh −89.9°。但 obs738 不在 node，故该 40.6 cm 单步只返回 pending，不能伪造到 J16 的完整行程。固定快照缺后续完整窗口，r126 hints 为空。
- Run19 J18 obs332/681：保留各自坐标与不同 fresh 集合；旧 −90°仍未完成，不冒充 obs681 当前 fresh，不删义务。J24/25 obs523/556 即使角集合相似也不 alias。U 保持 32。

## Run20 保守覆盖率

复算全部 200 轮、1376 observations、976 motions、102 个真实 take_exit 窗口。每轮入口与存档对照 v4 全部节点/出口几何，再同步存档 visits/completed/blocked；这些标志由原动作回调产生，本文不声称仅靠 observe 已还原它们。每次 query 验证旧 summary、U、trip 列表不变且第一角唯一 fresh 匹配。

81 条窗口成功完成；19 条被真实 front_clearance 拒绝；r29 obs184→187 离开后回原桶，拒绝；r200 obs1373→1376 尚未结束。没有补结果或选择性删帧。

| 当前 fresh 全 completed 且 U>0 的轮次 | hints |
| --- | ---: |
| 30 / obs220 | 0 |
| 140 / obs968 | 0 |
| 141 / obs978 | 0 |
| 151 / obs1050 | 3 |
| 152 / obs1060 | 3 |
| 156 / obs1086 | 3 |
| 173 / obs1201 | 3 |
| 183 / obs1264 | 0 |
| 190 / obs1309 | 3 |
| 193 / obs1330 | 3 |

严格口径 10 轮中 6 非空、4 空（60%）。r30 与唯一已知出发点相差 2.4 cm，虽然同桶、上下文兼容，也因 exact-position 拒绝；r140/141 的 J34 及 r183 的 J36 当时均无同桶已记录 departure。没有为提升比例放松规则。

r155/obs1079 hints 为空：它有一个 blocked 且未 completed 的 fresh，因此不属于上述“全 completed”分母；当时已知精确方向只到 J18，J18 全部出口 completed 或 blocked，没有可达未探索目标。r156/obs1086 有 3 个提示，当前角为 89.3°、89.3°、−89.9°，都真实唯一 fresh；前两目标为 J16 的 −90°/90°，第三为 J29 的 90°。完整路径、里程、每个 anchor 均见 findings。

跨轮窗口确实保留：r152–154 obs1061→1077，17 obs/12 motions、88.1 cm、J15→J17；r157–159 obs1094→1109，16 obs/11 motions、66.4 cm、J17→J31。r155 obs1080→1084 的反向 J17→J15 为另一条实际 88.0 cm 行程，未从正向推断。

这证明在部分历史状态能给出有证据的下一出口建议；尚未证明模型会选择它、到达新出口、减少 U 或收敛。候选不保证完成任务，也不改 done。
