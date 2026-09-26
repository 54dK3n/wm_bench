# 本轮补充复核入口（不替换原结果）

本文件只索引已存在的正式局证据和冻结实现，不改变 `REPORT.md`、`METRICS.json`、`SHA256SUMS`、原评测或原始日志，也不代表新的仿真运行。冻结源码提交为 `d1538f7570a42b760ad518f133eaefd7bcac83a8`。下文路径均相对仓库；为避免重复，`R` 指 `artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1`，`A` 指 `artifacts/autonomous-brain/stage1-review-20260926`。JSONL 以字段值定位，不能把决策轮次、观测序号和 tick 混用。

## 1. 道路换位：有实际运动，本局完整闭环成功为 0

入口是 `R/brain/rounds.jsonl` 中 `.round == 102` 的 `go_to(target_122)`。动作范围为观测 502–523；换位执行范围为观测 508–522，末尾 523 是动作最终观测。完整原件由证据归档提供，摘要是 `A/raw/formal-navigation-audit.json` 的 `.road_reposition[1]`。

候选记录没有独立 `candidate_id` 字段，其准确定位是该轮 `.result.evidence.road_reposition.attempts[0].candidate`，来源观测 `.observation_index=467`，`.source="observed_on_road_motion_endpoints"`，候选位置 `.position_m=[-0.002,1.358]` 米。这里的坐标来自大脑初始里程计坐标系（x 向右、z 向前），不是真值布局坐标。候选包含 15 条已观测运动边，记录的历史行程为 297.3 cm；这不是此次实际换位距离。各边的原运动/观测索引保留在 `.segments[]`，导航审计 `.candidate_support[]` 对全部 15 条逐项核查，没有只保留成功路段。

实际走过的道路段如下。位置均是脑端里程计，距离是对应窗口的里程计增量；转向包含在窗口内但不计为平移距离。原始依据为 `R/brain/motions.jsonl`、`R/brain/observations.jsonl` 和上述 `.attempts[0].steps[]`。

| 观测窗口 | 命令 | 到达位置 x,z（米） | 行程（cm） |
|---|---|---|---:|
| 508→510 | turn + follow_road | 0.092, 1.850 | 20.0 |
| 510→511 | follow_road | 0.216, 1.983 | 18.3 |
| 511→512 | follow_road | 0.345, 2.077 | 16.0 |
| 512→513 | follow_road | 0.493, 2.140 | 16.1 |
| 513→515 | turn + follow_road | 0.312, 2.057 | 20.0 |
| 515→516 | follow_road | 0.156, 1.932 | 20.0 |
| 516→517 | follow_road | 0.052, 1.764 | 20.0 |
| 517→518 | follow_road | 0.026, 1.667 | 10.0 |
| 518→520 | turn + take_exit | -0.250, 1.514 | 40.6 |
| 520→522 | turn + follow_road | -0.156, 1.514 | 9.4 |

合计 10 次平移、14 条基础命令（4 turn、9 follow_road、1 take_exit），里程计累计 **190.4 cm**。起点观测 508 的位置为 `[-0.040,1.776]`，末点与起点直线距离仅 28.6531 cm；逐段端点直线距离之和为 176.0237 cm。三者含义不同，不能把累计行程描述为朝候选前进了 190.4 cm。

停止原因为 `reposition_recorded_direction_not_uniquely_observed`。精确而言，观测 522 的车头为 -90°，下一候选方向相对车头为约 -45.369645°；当前道路传感器给出的出口为 82.9°、0°、-90.7°、-180°。冻结实现要求与目标方向的差严格小于 45°且恰有一个出口。0°、-90.7°分别相差约 45.369645°、45.330355°，所以本次是 **零个合格出口**，并非两个合格出口之间无法选择。该判定位于 `autonomous_brain/actions.py` 的 `Actions._follow_approach_path`。当时仍在道路上，但未到候选，`.reached=false`，后续视觉站位验证没有发生。

统计定义与本局数值：

- “换位动作数”：轮次结果含 `.result.evidence.road_reposition`，共 2 次（r16、r102）。r16 无可验证候选，未移动。
- “候选尝试数”：上述结果中 `attempts[]` 数量之和，为 1；“候选到达数”：其中 `reached==true` 数量，为 0。
- “完整候选换位成功数”：完成候选路径后重新观测并通过视觉站位验证，结果 `.status=="reposition_and_visual_standoff_verified"` 的换位动作数，为 **0**（导航审计 `.summary.reposition_plus_visual_success_count`）。只有移动或执行器返回 accepted/completed 均不计成功。
- 后续 r105 是模型另行选择 `explore`，r106 `go_to` 成功，r107 `pick` 成功；这条恢复链不能归入 r102 换位闭环成功。

实现与单测的入口是 `tests/test_brain_navigation_reposition.py`，尤其 `test_blocked_direct_approach_repositions_on_recorded_road_then_observes_success`（合成观测道路上的完整成功链）、`test_reposition_actuator_completed_without_displacement_is_not_success`、`test_no_observed_route_reports_need_to_explore_and_does_not_invent_an_edge`。既有通过记录见 [VALIDATION.json](VALIDATION.json) 和 `A/raw/final-directed-tests.txt`。单测通过证明这些受控场景，不证明正式局中换位闭环成功；本次没有重跑测试或仿真。

## 2. 四次抓放：保留两种审计的输入范围与原结论

原正式评测文件为 `A/raw/formal-evaluation/evaluation.json`，SHA256 为 `c8e8fad2a65e995b7c34d85ca88fef27a803ab2c5bc77b73c545ffdab35c5898`。其中 `.judge.counts` 仍是 **2 match / 2 unverifiable**，`false_positive=0`、`false_negative=0`、`eligible_actions=4`、`not_evaluated=107`。补充审计的 **4 match** 不覆盖或与其合并。

| 轮次/动作 | 脑对象 | 全局 Judge | 前缀身份绑定范围（包含两端） | 原判据下完整动作窗口 | 前缀 Judge |
|---|---|---|---|---|---|
| 21 / pick | target_017 | unverifiable | 观测 1–93 | 观测 93–107；tick 3953–4385 | match |
| 45 / place | target_017 | unverifiable | 观测 1–243 | 观测 243–250；tick 11583–11840 | match |
| 107 / pick | target_122 | match | 观测 1–540 | 观测 540–550；tick 26017–26314 | match |
| 110 / place | target_122 | match | 观测 1–585 | 观测 585–592；tick 28605–28890 | match |

原脚本 `tools/evaluate_autonomous_brain.py`（SHA256 `71c0b7410e29cd4859e2c0fdea4b6b8897d5f4ff96a3fb9aafb4013ca822b6be`）用全部 594 条观测及精确 frame/tick 对应的 captures 建立全局身份绑定，再用全部 111 轮、372 条运动记录和 native 样本/事件评价四次抓放。具体输入文件及原 SHA256 位于原评测的 `.inputs`，包含 `record.json.gz`、`captures.json.gz`、脑 summary/rounds/observations/motions/LLM/bridge 日志和驱动 manifest/evidence 等。全局 `target_017` 出现两个真值身份，因此两次历史动作得到 `missing_or_ambiguous_truth_binding`。

补充脚本是 [audit_action_prefix.py](audit_action_prefix.py)（SHA256 `326a45bdb37ac23cbd426478e8ab6c2c0f05c406a8b16f4a59e996a15b02e0fe`）。它先验证冻结 evaluator 和六个主要原件的 SHA256，并完整重现原全局 Judge；然后遍历日志中 **全部** pick/place，每次只将身份建立的历史范围统一限制为从观测 1 到该动作 `before_observation`（含），仍调用原 `evaluate_perception`/`evaluate_judge`。动作效果判定继续读取原完整动作窗口、同 tick 样本、gripper 和 grab/release/delivery 事件，未手工指定真值 ID，未选择性删掉冲突观测。frame 590 原件保留，并出现在完整全局复算和 r110 动作窗口中；它不在任何动作的“动作开始之前”身份前缀内。

以下均为离线复算命令；在完整恢复证据的仓库根目录运行，输出路径须是新的空缺路径。本次交付只补充入口，没有重跑仿真。

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/evaluate_autonomous_brain.py \
  --input artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --out /tmp/wm-stage1-reviewer-evaluation

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 artifacts/autonomous-brain/stage1-review-20260926/audit_action_prefix.py \
  --run-dir artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --evaluation artifacts/autonomous-brain/stage1-review-20260926/raw/formal-evaluation/evaluation.json \
  --evaluator tools/evaluate_autonomous_brain.py \
  --out /tmp/wm-stage1-reviewer-prefix-detail.json \
  --summary-out /tmp/wm-stage1-reviewer-prefix-summary.json
```

既有补充结果见 [ACTION_PREFIX_AUDIT.json](ACTION_PREFIX_AUDIT.json) 的 `.original_global_judge_counts`、`.prefix_binding_judge_counts`、`.global_judge_reproduced_exactly` 和 `.actions[]`；全部逐框诊断在 `A/raw/action-prefix-audit.json`。像素几何匹配仍保留原评测器“不能独立证明遮挡可见性”的限制。

## 3. frame 590：脑端误贴与离线歧义各发生在哪一层

定位：`R/brain/observations.jsonl` 中 `.observation_index=590`、`.observation.frameId=590`、`.observation.tick=28756`、`.round=110`、`.simulation_seconds=575.12`。它是 r110 第二次 place 中 `release` 的后观测：`R/brain/rounds.jsonl` 的 `.round=110`、`.result.evidence.place_trajectory[] | select(.method=="release")` 指向观测 589→590、tick 28722→28756，holding 从 true 变为 false。frame 590 不是 r590，也不是 done 的最终观测。

**大脑感知身份标签确实出错。** 该帧 `.perception.detections[]` 的一个红球框被标为 `.track_id="target_017"`、`.known_delivered_object_id="target_017"`、`.reason="matches_verified_placement"`，并有 `.fed_to_world_model=false`。冻结 `autonomous_brain/perception.py` 的 `Perception.update` 在已验证交付位置附近做一次一对一标签匹配，距离门为 0.15 m；该近场框误匹配了旧球身份。该关联发生于脑端 perception 适配层，不是 vendor WorldModel 内部本帧更新；不能因为未馈入 WM 就称大脑没有身份错误。

**离线评测随后出现全局身份歧义，但没有把冲突强行解析为一个身份。** 原 `evaluate_perception` 通过完整 captures 的同帧像素几何对应，发现 frame 590 这个框唯一对应 `guangyang-target-2`，与脑端的 `target_017` 标签冲突。它不以 `fed_to_world_model` 为过滤条件。`target_017` 的 49 条唯一对应证据中，48 条支持 `guangyang-target-1`、1 条（仅 frame 590）支持 `guangyang-target-2`，故 `.perception.ambiguous_track_ids` 包含这组冲突，并拒绝给出该 track 的全局唯一绑定。可核查 `A/raw/action-prefix-audit.json` 的 `.global_binding_ambiguities[0].identity_support`、`.first_observed_binding_conflicts`、`.diagnostic_observation_windows`。因此应准确表述为：脑端误贴导致离线全局绑定歧义；不是已证明的“离线像素匹配也把这帧配错”。

本次误贴的影响与边界可以按以下链条逐项核对：

| 检查项 | 可核查字段路径 | 既有记录 |
|---|---|---|
| frame 590 是否直接增加送达数 | 观测 590 `.objects[]` 中两对象的 `.state` | target_017 仍为 DELIVERED，target_122 仍为 HELD；该观测是在 release 返回后、生命周期更新前记录，不能把 HELD 解读为夹爪仍持球。同期 `.holding.holding=false`。 |
| 释放后未确认状态 | 观测 591 `.objects[]` | target_017 为 DELIVERED，target_122 为 RELEASED_UNVERIFIED；原代码先登记释放边界，再退后 25 cm 获取新视野。 |
| 最终放置 witness 用哪帧 | r110 `.result.evidence.release_observation.frame_id`、`.placement.frame_id`、`.candidate_witnesses` | release frame 为 590，但成功 witness 是 591；候选数量为 1，不能把 release frame 与验收 witness 混淆。 |
| 两球是否在同帧区分 | 观测 591 `.perception.detections[]`；逐框审计 `.same_frame_place_witness_audit[1].same_frame_red_detections[]` | 旧球框带 target_017，原像素对应为 guangyang-target-1；新球框无旧球标签，唯一对应 guangyang-target-2，并且是选中的 witness。 |
| 是否通过原放置判据 | 同一审计 `.original_candidate_count`、`.recomputed_candidate_count`、`.recomputed_placement_exactly_matches_original`、`.known_delivered_labels_match_pre_action_bindings` | 数量均为 1，后两项 true；旧/新球内椭圆值分别为 0.08604174924032237 / 0.2968370986920333，均通过未改动的 0.64 门。 |
| DELIVERED 何时出现 | 观测 592 `.objects[]` | 两个不同脑对象均为 DELIVERED。旧球标记在 590–592 期间未被改写成另一次送达；新球由 591 的唯一新 witness 确认。 |
| 两次交付是否去重 | r111 `.state.completion.delivered_object_ids`、`.delivery_evidence`；逐框审计 `.selected_delivery_witnesses_are_distinct_truth_objects` | ID 为 target_017、target_122；交付 witness 分别为 249、591（release 248、590）；distinct 标记 true。 |
| 最终 done 是否依赖 frame 590 误贴 | r111 `.state.completion`、`.state.robot`、`.llm_output.raw_output`、`.result.evidence` | 模型在 call 115 / decision 111 输出 `{"action":"done","params":{}}`；状态及执行后均计数 2、无未解决身份、无 pending/held、holding=false、ready_for_done=true；执行重新观测 594 后通过。最终证据明确引用 witness 249/591，未把 590 当作第二次成功 witness。 |

另外，首球 r45 的 witness 249 按原像素对应为 `guangyang-target-1`，内椭圆值 0.0705117149995101；第二次 witness 591 为另一球。相同放置函数重算入口是补充脚本中的 `Actions.placement_evidence` 与 `ball_inside_region` 调用，既有 `.all_same_frame_place_witnesses_verified=true`。这支持“本次没有造成最终重复计数或伪造 done”，不支持“全程身份关联无误”或“该误贴在其他情形永远无害”。错误保留在冻结源码和原证据中，原全局 Judge 的两个 unverifiable 也完整保留。
