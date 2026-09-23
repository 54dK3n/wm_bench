# 阶段 2 双球报告

已设门槛：FAIL / 未评估。独立场景双球送达 2/9；首次选择 9/10，已评估 10。

| 门槛 | 判定 |
|---|---|
| complete_ten_layouts_once | PASS |
| frozen_dependencies_unchanged | PASS |
| raw_trial_hashes_match_execution_ledger | PASS |
| no_regression_from_previous_successful_scenarios | PASS |
| program_errors_zero | PASS |
| observe_at_most_92 | PASS |
| vision_at_most_20mib | PASS |
| all_images_at_most_20mib | PASS |
| no_stationary_observe_or_guard_violation | PASS |
| on_road_entire_run | PASS |
| phantom_CONFIRMED_zero | PASS |
| fixed_rules_no_failure_successful_balls_all_pass | PASS |
| per_ball_approach_calls_at_most_3 | PASS |
| program_identity | PASS |
| no_target_anchor_access | PASS |
| no_layout_coordinates | PASS |
| run_finished | PASS |
| full_raw_record_preserved | PASS |
| samples_preserved | PASS |
| native_png_evidence_complete | FAIL / unknown |
| driver_keyframes_preserved | PASS |
| exact_render_bindings_complete | PASS |
| executed_source_matches_logged_sha | PASS |
| per_ball_image_bytes_reconcile | PASS |
| native_record_evidence_binding | FAIL / unknown |
| two_target_delivery_at_least_8_of_10_layouts | FAIL / unknown |
| P3_4_first_choice_matches_at_least_8_of_10_layouts | PASS |
| successful_two_delivery_median_seconds_at_most_300 | FAIL / unknown |
| measured_turn_cost_k_pass_and_frozen | PASS |

| 布局/球 | 来源/真实目标 | 首见→确认→抓取→送达(s) | WM误差cm | observe/图像bytes | 全里程/道路/直线cm | 道路比 | 真值前/侧cm | 接近前/实际抓取视线夹角° |
|---|---|---|---|---|---|---|---|---|
| map-01/1 | new_observations/guangyang-target-2 (B) | 13.5→42.92→62.9→None | 2.499551209717424 | 6/2099514 | 59.5/40.6/48.710762172973006 | 0.8334913721084571 | 11.441753594255234/1.204955529355257 | -40.2/-40.231559149007694 |
| map-01/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-02/1 | new_observations/guangyang-target-1 (C) | 35.7→65.16→105.78→144.98 | 5.439481822747432 | 6/2438247 | 186.8/160.29999999999998/63.096589582311026 | 2.5405493555382224 | 11.127537543398319/-3.6389347837712247 | 121.6/117.39110818302436 |
| map-02/2 | new_observations/None (None) | None→None→None→None | None | 49/12994340 | None/None/None | None | None/None | None/None |
| map-03/1 | new_observations/guangyang-target-2 (B) | 13.5→42.92→62.9→None | 2.499551209717424 | 6/2154980 | 59.5/40.6/48.710762172973006 | 0.8334913721084571 | 11.441753594255234/1.204955529355257 | -40.2/-40.231559149007694 |
| map-03/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-04/1 | new_observations/guangyang-target-2 (C) | 34.36→52.96→115.88→160.6 | 2.7074102593622418 | 8/2833792 | 398.79999999999995/353.3/93.60394099375739 | 3.77441372926341 | 13.329325607408027/-1.897757343149025 | 164.4/164.4450944432815 |
| map-04/2 | new_observations/None (None) | None→None→None→None | None | 55/13955382 | None/None/None | None | None/None | None/None |
| map-05/1 | new_observations/guangyang-target-1 (C) | 34.36→56.92→101.64→140.86 | 2.423080748241778 | 8/2963186 | 270.9/257.90000000000003/60.49210628030915 | 4.263366178802561 | 13.454802301475658/-1.609428433857411 | 103.3/103.26363526062744 |
| map-05/2 | new_observations/guangyang-target-2 (E) | 241.26→259.46→281.3→311.6 | 2.7297679045112884 | 16/4499528 | 72.70000000000027/60.0/58.31946723442382 | 1.0288159828144696 | 11.46882603864956/1.8739147202592379 | 0.4/0.3729184299469921 |
| map-06/1 | new_observations/guangyang-target-2 (D) | 38.34→58.4→81.62→178.04 | 8.172591770668596 | 10/3391297 | 129.3/122.6/71.7015816607525 | 1.7098646523596552 | 11.822588777184247/-4.737146663142049 | 116.6/110.64734835089064 |
| map-06/2 | new_observations/None (None) | None→None→None→None | None | 39/8745525 | None/None/None | None | None/None | None/None |
| map-07/1 | new_observations/None (None) | None→None→None→None | None | 54/11890779 | None/None/None | None | None/None | None/None |
| map-07/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-08/1 | new_observations/guangyang-target-1 (C) | 34.36→56.92→94.32→133.54 | 2.6022994639356924 | 8/2963616 | 221.20000000000005/207.9/60.44587333391637 | 3.43944075142259 | 13.16779078415546/-1.5167702778216836 | 102.7/102.73530736584422 |
| map-08/2 | new_observations/None (None) | None→None→None→None | None | 51/12422144 | None/None/None | None | None/None | None/None |
| map-09/1 | new_observations/guangyang-target-2 (E) | 69.06→89.28→138.52→None | 10.327191429062385 | 14/3974334 | 206.5/168.4/73.81779470516199 | 2.281292751600232 | 13.082412365261417/3.9003074511106397 | -45.8/-42.858159126807664 |
| map-09/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-10/1 | new_observations/guangyang-target-1 (D) | 41.28→48.94→61.5→104.2 | 3.6552368254328025 | 8/2786898 | 48.099999999999966/40/41.48449298557649 | 0.9642157134210939 | 13.531129361244322/2.100618194270286 | 17/17.019878584814847 |
| map-10/2 | new_observations/guangyang-target-2 (G) | 263.14→274.98→306.18→325.26 | 0.9937507861632363 | 21/5617867 | 178.5/145.0/66.48607395557723 | 2.18090784089435 | 14.431250000062501/9.846742617492874e-09 | -88.6/-88.5931387666095 |

| 布局 | 双球通过 | 仿真s | 整局observe/图像bytes | 退出日志 |
|---|---|---|---|---|
| map-01 | False | 63.2 | 6/2099514 | [{"line_index": 371, "event": "flow_end", "tick": 3159, "ball_index": 1, "track_id": "target_001", "target_source": "new_observations", "success": false, "stage": "delivery", "reason": "未找到可确认的目标物存放姿态或释放未验证", "one_target_released": false, "delivered_count": 0, "required_targets": 2, "navigation_queries": 134, "navigation_controls": 21, "full_targetDelivered": false, "holding": "目标物"}] |
| map-02 | False | 322.4 | 55/15432587 | [{"line_index": 8633, "event": "flow_end", "tick": 16120, "ball_index": 2, "track_id": null, "target_source": "new_observations", "success": false, "stage": "constraint", "reason": "navigation_queries_budget_exhausted", "one_target_released": true, "delivered_count": 1, "required_targets": 2, "navigation_queries": 1000, "navigation_controls": 133, "full_targetDelivered": false, "holding": null}] |
| map-03 | False | 63.2 | 6/2154980 | [{"line_index": 371, "event": "flow_end", "tick": 3159, "ball_index": 1, "track_id": "target_001", "target_source": "new_observations", "success": false, "stage": "delivery", "reason": "未找到可确认的目标物存放姿态或释放未验证", "one_target_released": false, "delivered_count": 0, "required_targets": 2, "navigation_queries": 134, "navigation_controls": 21, "full_targetDelivered": false, "holding": "目标物"}] |
| map-04 | False | 434.3 | 63/16789174 | [{"line_index": 6758, "event": "flow_end", "tick": 21714, "ball_index": 2, "track_id": "target_002", "target_source": "new_observations", "success": false, "stage": "constraint", "reason": "navigation_queries_budget_exhausted", "one_target_released": true, "delivered_count": 1, "required_targets": 2, "navigation_queries": 1000, "navigation_controls": 199, "full_targetDelivered": false, "holding": null}] |
| map-05 | True | 313.7 | 24/7462714 | [{"line_index": 3054, "event": "flow_end", "tick": 15686, "ball_index": 2, "track_id": "target_002", "target_source": "new_observations", "success": true, "stage": "delivery", "reason": null, "one_target_released": true, "delivered_count": 2, "required_targets": 2, "navigation_queries": 668, "navigation_controls": 161, "full_targetDelivered": true, "holding": null}] |
| map-06 | False | 510.6 | 49/12136822 | [{"line_index": 9627, "event": "flow_end", "tick": 25529, "ball_index": 2, "track_id": "target_002", "target_source": "new_observations", "success": false, "stage": "confirmation", "reason": "WorldModel 未通过 observe() 确认目标物", "one_target_released": true, "delivered_count": 1, "required_targets": 2, "navigation_queries": 944, "navigation_controls": 279, "full_targetDelivered": false, "holding": null}] |
| map-07 | False | 298.8 | 54/11890779 | [{"line_index": 8948, "event": "flow_end", "tick": 14938, "ball_index": 1, "track_id": "target_001", "target_source": "new_observations", "success": false, "stage": "confirmation", "reason": "WorldModel 未通过 observe() 确认目标物", "one_target_released": false, "delivered_count": 0, "required_targets": 2, "navigation_queries": 557, "navigation_controls": 124, "full_targetDelivered": false, "holding": null}] |
| map-08 | False | 379.9 | 59/15385760 | [{"line_index": 12347, "event": "flow_end", "tick": 18995, "ball_index": 2, "track_id": null, "target_source": "new_observations", "success": false, "stage": "confirmation", "reason": "WorldModel 未通过 observe() 确认目标物", "one_target_released": true, "delivered_count": 1, "required_targets": 2, "navigation_queries": 862, "navigation_controls": 174, "full_targetDelivered": false, "holding": null}] |
| map-09 | False | 259.6 | 14/3974334 | [{"line_index": 1339, "event": "flow_end", "tick": null, "ball_index": 1, "track_id": "target_001", "target_source": "new_observations", "success": false, "stage": "constraint", "reason": "navigation_queries_budget_exhausted", "one_target_released": false, "delivered_count": 0, "required_targets": 2, "navigation_queries": 1000, "navigation_controls": 109, "full_targetDelivered": false, "holding": "目标物"}] |
| map-10 | True | 327.4 | 29/8404765 | [{"line_index": 1535, "event": "flow_end", "tick": 16369, "ball_index": 2, "track_id": "target_002", "target_source": "new_observations", "success": true, "stage": "delivery", "reason": null, "one_target_released": true, "delivered_count": 2, "required_targets": 2, "navigation_queries": 714, "navigation_controls": 192, "full_targetDelivered": true, "holding": null}] |

None/unknown 不当作零；全部原始行、精确 tick/事件、PNG 哈希、逐球固定规则、里程边界见 opt2_report.json。首见允许早于该球开始。100cm 仅供方位候选；精确首见必须未封顶且唯一关联。末次离开失败不撤销已经验证的实际送达。600s 仅报告，不增加为阶段2硬门。

回归：

```json
{
  "previous_report": "/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/opt_report.json",
  "previous_report_sha256": "5358c1c19072748a49cc2d43191b710d752081d4361c323e31a6158e0c35a9da",
  "scope": "opt1-r2 successful capture scenarios, first current ball only",
  "checks": [
    {
      "previous_scenario": "S01",
      "members": [
        "map-01",
        "map-03"
      ],
      "passed": true,
      "failed_maps": []
    },
    {
      "previous_scenario": "S02",
      "members": [
        "map-02"
      ],
      "passed": true,
      "failed_maps": []
    },
    {
      "previous_scenario": "S03",
      "members": [
        "map-04"
      ],
      "passed": true,
      "failed_maps": []
    },
    {
      "previous_scenario": "S04",
      "members": [
        "map-05"
      ],
      "passed": true,
      "failed_maps": []
    },
    {
      "previous_scenario": "S05",
      "members": [
        "map-06"
      ],
      "passed": true,
      "failed_maps": []
    },
    {
      "previous_scenario": "S07",
      "members": [
        "map-08"
      ],
      "passed": true,
      "failed_maps": []
    },
    {
      "previous_scenario": "S08",
      "members": [
        "map-09"
      ],
      "passed": true,
      "failed_maps": []
    },
    {
      "previous_scenario": "S09",
      "members": [
        "map-10"
      ],
      "passed": true,
      "failed_maps": []
    }
  ],
  "regressions": []
}
```
