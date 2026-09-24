# MUTATION-REPORT — 变异测试对照

目的：证明验收测试在实现出错时会变红。方法：注入 8 个已知缺陷，逐一跑离线套件，对照变异前后指定测试的结果。

## 注入方式

| 变异 | 注入方式 |
|---|---|
| 关联门控基础值 0.5 m → 50.0 m | 构造参数 `AssociationConfig.gate_distance_m` |
| 门控上限 2.0 m → 0.01 m | 构造参数 `AssociationConfig.max_gate_distance_m` |
| confirm_hits 3 → 1 | 构造参数 `DecayConfig.confirm_hits` |
| 视野内漏检半衰期 1.5 s → 600 s | 构造参数 `DecayConfig.half_life_in_fov_missed_s` |
| 最短转角去掉归一化 | 运行时把 `selection.turn.normalize_turn_deg`（及各再导出处）替换为 `target - current` |
| 代价函数 k → 0 | 运行时把 `selection.selector.candidate_cost` 替换为只返回距离；先用探针确认 `score_candidate` 的代价确实不再随转角变化 |
| 欧氏距离替代最短路 | 运行时把 `selection.graph.dijkstra`（及 selector 命名空间中的同名引用）替换为节点坐标欧氏距离；探针确认 `path_distance_cm` 变为欧氏值 |
| 契约多加 obj_id | 运行时包装 `world_model.adapters.to_scene_observation(s)` 追加 `obj_id`；探针确认输出含该键 |

源码级变异没有读取任何被禁文件：替换的是公开导出函数；每个变异都带“是否生效”探针（表中“探针”列）。
配置级变异不需要探针（参数经构造函数直接进入被测对象）。

## 运行模式说明

D1 修复后，基线在正式模式（`WM_ACCEPT_HEADING_SIGN=1`）全绿。本报告只以正式模式矩阵作为判定依据；
诊断模式（`WM_ACCEPT_HEADING_SIGN=-1`）仅作参考，不得用于判定测试有效性。

## 对照矩阵（正式模式，判定依据）

| 变异 | 必须变红的测试 | 变异前 | 变异后 | 关键指标（前 → 后） | 变异生效探针 | 结论 |
|---|---|---|---|---|---|---|
| 关联门控基础值 0.5 m → 50.0 m | `test_2_4_no_false_merge` | PASSED | FAILED | total_merges: 0 → 21 | 不适用（配置级） | 有效（绿→红） |
| 关联门控基础值 0.5 m → 50.0 m | `test_2_8_gate_grows_with_time_gap_and_is_capped` | PASSED | FAILED | total_merges: 0 → 21 | 不适用（配置级） | 有效（绿→红） |
| 门控上限 2.0 m → 0.01 m | `test_2_3_no_track_split` | PASSED | FAILED | total_splits: 0 → 40 | 不适用（配置级） | 有效（绿→红） |
| confirm_hits 3 → 1 | `test_2_2_track_count_matches_truth` | PASSED | FAILED | correct_layouts: 10 → 3 | 不适用（配置级） | 有效（绿→红） |
| 视野内漏检半衰期 1.5 s → 600 s | `test_2_5_grabbed_target_goes_stale_within_3s` | PASSED | FAILED | passed: 10 → 0 | 不适用（配置级） | 有效（绿→红） |
| 最短转角去掉归一化，直接返回 target - current | `test_3_2_shortest_turn_20_cases` | PASSED | FAILED | failures: 0 → 26 | 生效 | 有效（绿→红） |
| 代价函数转向项系数 k → 0 | `test_3_3_cost_optimal_beats_euclidean_nearest` | PASSED | FAILED | selection_correct: 10 → 5 | 生效 | 有效（绿→红） |
| 路径距离改用欧氏距离替代图上最短路 | `test_3_3_cost_optimal_beats_euclidean_nearest` | PASSED | FAILED | selection_correct: 10 → 5 | 生效 | 有效（绿→红） |
| 路径距离改用欧氏距离替代图上最短路 | `test_3_4_first_target_uses_graph_shortest_not_euclidean` | PASSED | FAILED | selection_correct: 10 → 5 | 生效 | 有效（绿→红） |
| 契约输出多加一个 obj_id 字段 | `test_2_6_contract_fields_exactly_eight` | PASSED | FAILED | problems: 0 → 18 | 生效 | 有效（绿→红） |

## 逐变异结论

- **关联门控基础值 0.5 m → 50.0 m**：`test_2_4_no_false_merge` 绿→红；`test_2_8_gate_grows_with_time_gap_and_is_capped` 绿→红
- **门控上限 2.0 m → 0.01 m**：`test_2_3_no_track_split` 绿→红
- **confirm_hits 3 → 1**：`test_2_2_track_count_matches_truth` 绿→红
- **视野内漏检半衰期 1.5 s → 600 s**：`test_2_5_grabbed_target_goes_stale_within_3s` 绿→红
- **最短转角去掉归一化，直接返回 target - current**：`test_3_2_shortest_turn_20_cases` 绿→红
- **代价函数转向项系数 k → 0**：`test_3_3_cost_optimal_beats_euclidean_nearest` 绿→红
- **路径距离改用欧氏距离替代图上最短路**：`test_3_3_cost_optimal_beats_euclidean_nearest` 绿→红；`test_3_4_first_target_uses_graph_shortest_not_euclidean` 绿→红
- **契约输出多加一个 obj_id 字段**：`test_2_6_contract_fields_exactly_eight` 绿→红

全部 10 条正式模式对照均为绿→红。
