# 完整公开日志：首次阻塞与后续恢复

本文的“交付 1/2”均为公开脑端状态口径，不是独立验收通过数。冻结观测命令链审计实际通过 0 条：第二次 grab 前对象为 STALE，导致抓取及后续交付链拒绝。该结果与本文公开计数一并保留，见 [EVIDENCE_CHAIN_REVIEW.md](EVIDENCE_CHAIN_REVIEW.md)。

冻结源码 `a847a3c538c2787864633753b74dd906098ff6fd`。本页只复算已结束的四份公开脑日志，不读取 record、capture、布局或评测真值，不重跑脑、模型、仿真或验收器。`r` 为决策轮，`o` 为观测序号；本轮二者分别对应 rounds.jsonl、observations.jsonl 的行号。所有对象 ID 均为脑端轨迹 ID，不是物理球真值身份。

**本轮终止是外部 HTTP 402；此前的控制阻塞已有部分恢复。** summary 为 `failed / LLMRequestError: LLM request failed: HTTPError HTTP 402; see transcript`。r97 的 `action=null`，没有执行该轮动作；共 97 轮记录、96 个有效动作、596 次观测、402 条动作原语、97 次模型调用记录，模拟时间 673.06 秒。不能把 HTTP 异常归为控制器根因，也不能推断未发生的剩余运行会成功或失败。结束时手空、无 pending_grasp、公开完成状态仅交付 1/2、`ready_for_done=false`，模型没有选择 `done`。

**“首次阻塞”分三种入口。** 按所有动作结果，最早受阻是 r7/o22–29 的 `road_blocked_returned_to_observed_node`，它不表示回到了原路口。按红球主动确认链，最早实质阻塞是 r9；按已确认红球的抓取接近链，最早失败是 r31，但随后 r33 已恢复成功。不能继续将“完整候选换位成功次数为 0”沿用到本轮。

r8/o30–32 的普通 explore 只执行一次 31.6° 转向，o31 得到 `target_017` 的首个有效 hit，程序在 take_exit 前交回决策；o32 的最终新鲜观测仍保留机会。全局仅此 **1 次内部 handoff，1 次后置保留**。r9 选择该稳定发现 `red-discovery-3`，o33→34 实际 forward 15.5 cm（净位移 15.524 cm），017 从 1 hit 增至 2 hit，但来源像素关联被拒，结果 `confirmation_source_pixels_not_compatible`。原框仍在：raw 距离 83→79 cm、方位 −11.56→−13.53°；计划预测距离 67.800 cm。它是关联证据未通过，不能写成“机器人未动”“无新增 hit”或“原红框消失”，也不能仅凭公开框判断物理原因。

| 主动采样 | 实际里程 / 所选关联轨迹新增 hit | 停止与恢复证据 |
|---|---:|---|
| r9，o33–35 | 15.5 cm / 1 | `source_pixels_not_compatible`，未确认 |
| r24，o91–93 | 17.0 cm / 0 | `needs_fresh_observation`；原发现 raw=100 的饱和距离未形成可恢复的窗内有效视角，恢复判定拒绝 `previous_unique_admitted_view_unavailable`，没有发恢复原语。o92 仍有红框并新建038的首个 hit，不能硬算作原发现连续关联的 hit |
| r25，o94–95 | 0 cm / 0 | 对新发现 `red-discovery-22` 无安全独立视点；保留侧向道路余量、位姿间隔、距离窗和转向出视野四类拒绝依据 |

因此主动采样 **3 次，成功确认动作 0 次；所选关联轨迹新增 hit 1 次**。采样窗口内所有红轨迹合计新增 2 个 `(track_id,frame_id)` hit，另一个是 r24 的038首个 hit，两种口径分列。恢复判定 1 次、执行恢复原语 0 次、恢复成功 0 次；没有采样 repeat guard 命中。完整局公开红框统计为 **163 raw → 37 fed → 12 唯一 track/frame hit**，对应017/027/038各2/8/2 hit；这三个轨迹不能解释成三颗物理球。

**确认后换位的失败与成功都保留。** 唯一达到 CONFIRMED 的红轨迹027，在 r30/o113（tick 4769，95.38 秒）取得第3个 hit；此前 o65、o66 已有两次。r31 首次 go_to 选择027。

| 正式候选执行 | 整次 go_to：里程 / 净位移 | 仅候选路线：里程 / 净位移 | 结果 |
|---|---:|---:|---|
| r31，候选脑坐标 `[-1.949,0.919]` | 481.0 / 30.424 cm | o135→149：188.8 / 129.476 cm | 未到达；`reposition_unrecorded_junction_inside_segment` |
| r33，候选脑坐标 `[-1.986,1.142]` | 266.5 / 116.445 cm | o164→175：129.1 / 66.155 cm | 到达，随后视觉接近通过；最终o180仍为 `target_seen_at_standoff` |

r31 已实际用 backward 完成两段 basic 逆向（9.4、10 cm），随后 follow_road 重走已记录道路。最后一段 `road-segment-123-124` 的历史弧长31.8 cm，本次 o147→149 只走9.4 cm即收到 `stoppedBy=junction`，不能提前消费剩余路线；整段弧长与端点直距27.310 cm也不支持把余段当作直线连接。此时停在记录端点前，保留失败。r33 在更新后的证据下选择另一条路线，先 backward 9.8 cm，再 follow_road，o172→173 对齐原 body heading −96.4°，最后 forward 10、9.4 cm，到达后另按目标视觉转向和接近；不要把目标转向混成道路到达航向。

两次候选查询合计生成6行、合法6行、返回短名单5行；这是含重复枚举的查询行数。完整公开状态还出现18个不同 route_version，不等于18次执行。**实际候选尝试2次、到达1次、完整换位成功1次**；完整成功定义为同次 go_to `success=true` 且 `road_reposition.status=reposition_and_visual_standoff_verified`，仅到达不算。

随后 r34 执行1个 pick（包含2次 grab 原语，最终公开身份状态 HELD），r52 执行1个 place（1次 release，o350为视觉见证、o351状态 DELIVERED）。存放区导航曾受阻，r44/o322–323、r45/o324–325 的2次 `navigation_repeat_without_new_evidence` 都是零原语、零里程；没有把拒绝当成功，也不推测节省了多少反事实运动。全局 go_to 15次、成功4次。结束时两个从未确认的轨迹017、038为 LOST/retired_unconfirmed_hypothesis；发现账62条未解决记录、58个假设仍保留，均不是物理球数量。本轮仅一个红轨迹完成确认和交付，数量任务未满足；这与更晚的 HTTP 402 外部终止分别陈述。

复核入口为 [诊断结果](raw/analysis/formal-public-diagnosis.json)：`sampling`、`confirmed_track_timeline`、`repositioning.actions`、`exploration_handoffs`、`repeat_guards` 均保留原行 SHA、JSON 指针及实际 motion/observation 窗口。[复算脚本](scripts/diagnose_formal_public.py) 仅读四个文件，观测流式读取，不重复计数 sampling_progress 中镜像的采样证据；stdout、stderr和退出码见 `raw/analysis/formal-public-diagnosis.*`。执行退出0，输入前后 stat 和全文件 SHA256 均一致，原公开数据连接问题0。重算必须选新的输出路径：

```sh
python3 artifacts/autonomous-brain/executable-recovery-20260927/scripts/diagnose_formal_public.py --brain-dir artifacts/autonomous-brain/executable-recovery-20260927/raw/formal-stage1/map-05-run-1/brain --output /tmp/executable-recovery-public-recheck.json
```

原输入 SHA256（目录 `raw/formal-stage1/map-05-run-1/brain/`）：

| 文件 | SHA256 |
|---|---|
| summary.json | `42fb52e45ba60ef00bb0d94b0008330f47a69ed213f42920a63657132b7ce5a6` |
| rounds.jsonl | `4fe18cfa2a6780e0ae3ff71dc6be2b9e546877440f386d7b9ace26d0bbc5b48a` |
| motions.jsonl | `de2940ed92b3f135c488d0045472cfef9d0f8b3ee30346c0cd3ea2f0e096642a` |
| observations.jsonl | `8219c632d50cd078cf2f3877baf0c7f580dce8b00c3baed19b2b2f32073d05df` |

复算脚本 SHA256：`8cffa0fab3b398f5d6887b7759cb54eef08b074a545ca21aa50fee10d0636a1f`。本文不替代独立验收结果，不用公开检测缺失推断物理遮挡或 CV 漏失原因。
