# 阶段一独立场景评测

独立场景确认且抓到：3/9；80% 门限需至少 8 组成功。组内一局失败即该组失败。

| 场景 | 本轮成员 | 各局确认且抓到 | 组结果 | 组内差异 |
|---|---|---|---|---|
| S01 B 场景 | map-01, map-03 | {'map-01': True, 'map-03': True} | PASS | 无 |
| S02 C 场景 | map-02 | {'map-02': False} | FAIL | 无 |
| S03 C 场景 | map-04 | {'map-04': True} | PASS | 无 |
| S04 C 场景 | map-05 | {'map-05': False} | FAIL | 无 |
| S05 D 场景 | map-06 | {'map-06': False} | FAIL | 无 |
| S06 无对应真球 场景 | map-07 | {'map-07': False} | FAIL | 无 |
| S07 C 场景 | map-08 | {'map-08': False} | FAIL | 无 |
| S08 无对应真球 场景 | map-09 | {'map-09': False} | FAIL | 无 |
| S09 D 场景 | map-10 | {'map-10': True} | PASS | 无 |

门限：
- complete_ten_layouts: PASS
- program_errors_zero: FAIL
- stationary_repeat_observes_zero: PASS
- observe_motion_guard_violations_zero: PASS
- observe_budget_92: PASS
- vision_budget_20mib: PASS
- independent_confirmed_and_grabbed_at_least_80_percent: FAIL
- fixed_rules_no_failures_all_runs: PASS
- fixed_rules_all_pass_for_confirmed_and_grabbed: PASS

逐布局审计值（不作为性能平均分母）：

| 布局 | WM 30cm 内关联 | 确认且抓到 | 重复 / guard阻止 | observe | 证据 MiB | program_error |
|---|---|---|---|---|---|---|
| map-01 | B | True | 0 / 0 | 7 | 2.0659 | 0 |
| map-02 | C | False | 0 / 0 | 6 | 1.4894 | 0 |
| map-03 | B | True | 0 / 0 | 7 | 2.1086 | 0 |
| map-04 | C | True | 0 / 0 | 9 | 2.5335 | 0 |
| map-05 | C | False | 0 / 0 | 8 | 2.009 | 0 |
| map-06 | D | False | 0 / 0 | 10 | 2.4401 | 0 |
| map-07 | 无对应真球 | False | 0 / 0 | 23 | 5.2372 | 1 |
| map-08 | C | False | 0 / 0 | 8 | 2.009 | 0 |
| map-09 | 无对应真球 | False | 0 / 0 | 17 | 4.1969 | 1 |
| map-10 | D | True | 0 / 0 | 8 | 2.3252 | 1 |

分组从首个 WM 命中前的 observe 开始（无 WM 时从首个红球检测），在投放开始前结束。去绝对 tick、轨迹/包裹 ID、蓝球和前期巡逻，坐标减首个采样位姿；保留事件顺序、红球读数、确认决策与移动结果。
近似容差固定为距离 3cm、相对坐标 3cm、方位 2°、置信度 0.05、相对 tick 2；计数和类别必须相同。每组所有成员两两通过，不使用传递链合并。本轮按本轮轨迹重新分组；旧六组只作另列的保守对照，不冒充本轮独立场景。

逐字段差值、归一轨迹及原始日志行索引保存在 stage_report.json；投放差异单独保留。
E/G 仅统计 30cm 内确实关联的轨迹；未关联 WM 不计入测试精度，不能由最近邻贴标签。

旧六组保守对照：1/6。

| 旧组成员 | 本轮各局结果 | 保守组结果 | 本轮轨迹仍等价 |
|---|---|---|---|
| map-01, map-03 | {'map-01': True, 'map-03': True} | PASS | True |
| map-02 | {'map-02': False} | FAIL | True |
| map-04, map-05, map-08 | {'map-04': True, 'map-05': False, 'map-08': False} | FAIL | False |
| map-06, map-10 | {'map-06': False, 'map-10': True} | FAIL | False |
| map-07 | {'map-07': False} | FAIL | True |
| map-09 | {'map-09': False} | FAIL | True |

固定规则证据审计（unknown 不等于通过，未到达该阶段也不虚构证据）：

| 固定规则 | pass | fail | unknown |
|---|---|---|---|
| confirmation_exactly_three_hits | map-01, map-02, map-03, map-04, map-05, map-06, map-08, map-10 | — | map-07, map-09 |
| confirmation_all_hits_in_40_90cm | map-01, map-02, map-03, map-04, map-05, map-06, map-08, map-10 | — | map-07, map-09 |
| confirmation_same_track_id | map-01, map-02, map-03, map-04, map-05, map-06, map-08, map-10 | — | map-07, map-09 |
| confirmation_all_pair_gaps_at_least_15cm | map-01, map-02, map-03, map-04, map-05, map-06, map-08, map-10 | — | map-07, map-09 |
| confirmation_last_wm_distance_at_least_0_5m | map-01, map-02, map-03, map-04, map-05, map-06, map-08, map-10 | — | map-07, map-09 |
| pure_memory_drive_at_least_30cm_before_approach | map-01, map-03, map-04, map-10 | — | map-02, map-05, map-06, map-07, map-08, map-09 |
| approach_wm_distance_at_most_0_25m | map-01, map-03, map-04, map-10 | — | map-02, map-05, map-06, map-07, map-08, map-09 |
| approach_max_steps_one | map-01, map-03, map-04, map-10 | — | map-02, map-05, map-06, map-07, map-08, map-09 |
| approach_at_most_three_per_confirmed_ball | map-01, map-02, map-03, map-04, map-05, map-06, map-08, map-10 | — | map-07, map-09 |
| on_road_entire_run | map-01, map-02, map-03, map-04, map-05, map-06, map-07, map-08, map-09, map-10 | — | — |
| observe_count_at_most_92 | map-01, map-02, map-03, map-04, map-05, map-06, map-07, map-08, map-09, map-10 | — | — |
| vision_bytes_at_most_20mib | map-01, map-02, map-03, map-04, map-05, map-06, map-07, map-08, map-09, map-10 | — | — |

完整平台 run_finished + off_road episodes/durationMs/maxSeverity 均为 0，可证明平台记录的全程在路上；仅零星 onRoad=true 不能判通过。每次确认的三点检查所有两两间距，并通过显式 track_id 或唯一前置 WM 轨迹及匹配 hit 计数核对同轨迹。
任一局固定规则 fail 都使总门限失败；已经确认且抓到的局，所有固定规则必须 pass。未成功局未进入阶段的 unknown 保留，不单独否定原有 80% 门限。
本报告只评估阶段一；后续阶段未执行、未宣称完成。每阶段最多三轮，每轮必须完整十布局。
