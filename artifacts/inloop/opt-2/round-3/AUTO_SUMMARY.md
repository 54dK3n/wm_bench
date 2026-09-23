# 阶段 2 双球报告

已设门槛：FAIL / 未评估。独立场景双球送达 2/10；首次选择 9/10，已评估 9。

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
| native_png_evidence_complete | PASS |
| driver_keyframes_preserved | PASS |
| exact_render_bindings_complete | PASS |
| executed_source_matches_logged_sha | PASS |
| per_ball_image_bytes_reconcile | PASS |
| native_record_evidence_binding | PASS |
| two_target_delivery_at_least_8_of_10_layouts | FAIL / unknown |
| P3_4_first_choice_matches_at_least_8_of_10_layouts | PASS |
| successful_two_delivery_median_seconds_at_most_300 | PASS |
| measured_turn_cost_k_pass_and_frozen | PASS |

| 布局/球 | 来源/真实目标 | 首见→确认→抓取→送达(s) | WM误差cm | observe/图像bytes | 全里程/道路/直线cm | 道路比 | 真值前/侧cm | 接近前/实际抓取视线夹角° |
|---|---|---|---|---|---|---|---|---|
| map-01/1 | new_observations/guangyang-target-2 (B) | 13.5→42.92→55.76→None | 2.499551209717424 | 6/2097572 | 59.5/40.6/48.71076217332172 | 0.8334913721024902 | 11.44175359422267/1.2049555285938427 | -40.2/-40.231559147231565 |
| map-01/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-02/1 | new_observations/guangyang-target-1 (C) | 35.7→65.16→93.24→129.5 | 5.439481822747432 | 6/2438868 | 186.7/160.2/63.096589583415685 | 2.5389644837810215 | 11.127537544115377/-3.6389347811437864 | 121.6/117.39110817569053 |
| map-02/2 | new_observations/guangyang-target-2 (D) | None→196.70000000000002→None→None | 5.331581027237634 | 14/3481357 | None/None/None | None | None/None | None/None |
| map-03/1 | new_observations/guangyang-target-2 (B) | 13.5→42.92→55.76→86.32 | 2.499551209717424 | 6/2329321 | 59.5/40.6/48.71076217332172 | 0.8334913721024902 | 11.44175359422267/1.2049555285938427 | -40.2/-40.231559147231565 |
| map-03/2 | new_observations/None (None) | None→None→None→None | None | 28/6063774 | None/None/None | None | None/None | None/None |
| map-04/1 | new_observations/guangyang-target-2 (C) | 34.36→52.96→97.94→141.44 | 2.7074102593622418 | 8/2832159 | 398.79999999999995/353.3/93.603940993952 | 3.774413729255563 | 13.329325607660431/-1.897757340737284 | 164.4/164.44509443640607 |
| map-04/2 | new_observations/None (None) | None→None→None→None | None | 30/6546672 | None/None/None | None | None/None | None/None |
| map-05/1 | new_observations/guangyang-target-1 (C) | 34.36→56.92→87.08→123.36 | 2.423080748241778 | 8/2960335 | 270.9/257.90000000000003/60.49210628094769 | 4.2633661787575585 | 13.45480230162929/-1.6094284320544487 | 103.3/103.26363525592922 |
| map-05/2 | new_observations/guangyang-target-2 (E) | 192.20000000000002→200.56→290.22→319.6 | 7.30242307816383 | 16/4350725 | 750.5999999999999/649.8/100.614209764787 | 6.458332292417579 | 15.64982114305217/-1.9206052784653636 | 156.6/152.2296903242401 |
| map-06/1 | new_observations/guangyang-target-2 (D) | 38.34→58.4→74.38→167.1 | 8.172591770668596 | 10/3393190 | 129.3/122.6/71.70158165768962 | 1.7098646524326955 | 11.822588774772212/-4.737146673325906 | 116.6/110.64734838240327 |
| map-06/2 | new_observations/None (None) | None→None→None→None | None | 30/6423582 | None/None/None | None | None/None | None/None |
| map-07/1 | new_observations/None (None) | None→None→None→None | None | 26/5667316 | None/None/None | None | None/None | None/None |
| map-07/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-08/1 | new_observations/guangyang-target-1 (C) | 34.36→56.92→81.62→117.9 | 2.6022994639356924 | 8/2966393 | 221.20000000000005/207.9/60.44587333492204 | 3.439440751365366 | 13.167790784360795/-1.5167702751417982 | 102.7/102.73530735896873 |
| map-08/2 | new_observations/None (None) | None→None→None→None | None | 39/9328300 | None/None/None | None | None/None | None/None |
| map-09/1 | new_observations/guangyang-target-2 (E) | 69.06→89.78→129.46→None | 10.327191429062385 | 15/4207049 | 206.5/168.4/73.81779470398695 | 2.2812927516365455 | 13.0824123669438/3.9003074510163835 | -45.8/-42.85815912577635 |
| map-09/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-10/1 | new_observations/guangyang-target-1 (D) | 41.28→48.94→56.12→97.6 | 3.6552368254328025 | 8/2786314 | 48.099999999999966/40/41.48449298569756 | 0.9642157134182799 | 13.531129361257433/2.100618194744166 | 17/17.019878584299192 |
| map-10/2 | new_observations/guangyang-target-2 (G) | 203.56→215.1→236.12→255.18 | 1.0188427871855528 | 22/5879581 | 178.79999999999973/145.0/66.44726385837579 | 2.182181651738885 | 14.2312500000625/9.559139320515164e-09 | -88.7/-88.71416268806732 |

| 布局 | 双球通过 | 仿真s | 整局observe/图像bytes | 退出日志 |
|---|---|---|---|---|
| map-01 | False | 207 | 6/2097572 | [{"line_index": 682, "event": "flow_end", "tick": null, "ball_index": 1, "track_id": "target_001", "target_source": "new_observations", "success": false, "stage": "constraint", "reason": "navigation_queries_budget_exhausted", "one_target_released": false, "delivered_count": 0, "required_targets": 2, "navigation_queries": 1000, "navigation_controls": 74, "full_targetDelivered": false, "holding": "目标物"}] |
| map-02 | False | 454.5 | 20/5920225 | [{"line_index": 3478, "event": "flow_end", "tick": 22727, "ball_index": 2, "track_id": "target_002", "target_source": "new_observations", "success": false, "stage": "constraint", "reason": "navigation_queries_budget_exhausted", "one_target_released": true, "delivered_count": 1, "required_targets": 2, "navigation_queries": 1000, "navigation_controls": 300, "full_targetDelivered": false, "holding": null}] |
| map-03 | False | 203.6 | 34/8393095 | [{"line_index": 773, "event": "flow_end", "tick": 10182, "ball_index": 2, "track_id": null, "target_source": "new_observations", "success": false, "stage": "confirmation", "reason": "WorldModel 未通过 observe() 确认目标物", "one_target_released": true, "delivered_count": 1, "required_targets": 2, "navigation_queries": 507, "navigation_controls": 137, "full_targetDelivered": false, "holding": null}] |
| map-04 | False | 265.3 | 38/9378831 | [{"line_index": 1872, "event": "flow_end", "tick": 13266, "ball_index": 2, "track_id": null, "target_source": "new_observations", "success": false, "stage": "confirmation", "reason": "WorldModel 未通过 observe() 确认目标物", "one_target_released": true, "delivered_count": 1, "required_targets": 2, "navigation_queries": 574, "navigation_controls": 153, "full_targetDelivered": false, "holding": null}] |
| map-05 | True | 321.7 | 24/7311060 | [{"line_index": 2291, "event": "flow_end", "tick": 16086, "ball_index": 2, "track_id": "target_002", "target_source": "new_observations", "success": true, "stage": "delivery", "reason": null, "one_target_released": true, "delivered_count": 2, "required_targets": 2, "navigation_queries": 748, "navigation_controls": 197, "full_targetDelivered": true, "holding": null}] |
| map-06 | False | 291 | 40/9816772 | [{"line_index": 2250, "event": "flow_end", "tick": 14549, "ball_index": 2, "track_id": null, "target_source": "new_observations", "success": false, "stage": "confirmation", "reason": "WorldModel 未通过 observe() 确认目标物", "one_target_released": true, "delivered_count": 1, "required_targets": 2, "navigation_queries": 602, "navigation_controls": 175, "full_targetDelivered": false, "holding": null}] |
| map-07 | False | 151.7 | 26/5667316 | [{"line_index": 239, "event": "flow_end", "tick": 7583, "ball_index": 1, "track_id": null, "target_source": "new_observations", "success": false, "stage": "confirmation", "reason": "WorldModel 未通过 observe() 确认目标物", "one_target_released": false, "delivered_count": 0, "required_targets": 2, "navigation_queries": 245, "navigation_controls": 86, "full_targetDelivered": false, "holding": null}] |
| map-08 | False | 254.3 | 47/12294693 | [{"line_index": 1739, "event": "flow_end", "tick": 12716, "ball_index": 2, "track_id": null, "target_source": "new_observations", "success": false, "stage": "confirmation", "reason": "WorldModel 未通过 observe() 确认目标物", "one_target_released": true, "delivered_count": 1, "required_targets": 2, "navigation_queries": 618, "navigation_controls": 153, "full_targetDelivered": false, "holding": null}] |
| map-09 | False | 284.7 | 15/4207049 | [{"line_index": 1444, "event": "flow_end", "tick": 14233, "ball_index": 1, "track_id": "target_001", "target_source": "new_observations", "success": false, "stage": "constraint", "reason": "navigation_queries_budget_exhausted", "one_target_released": false, "delivered_count": 0, "required_targets": 2, "navigation_queries": 1000, "navigation_controls": 130, "full_targetDelivered": false, "holding": "目标物"}] |
| map-10 | True | 257.3 | 30/8665895 | [{"line_index": 1539, "event": "flow_end", "tick": 12865, "ball_index": 2, "track_id": "target_002", "target_source": "new_observations", "success": true, "stage": "delivery", "reason": null, "one_target_released": true, "delivered_count": 2, "required_targets": 2, "navigation_queries": 676, "navigation_controls": 190, "full_targetDelivered": true, "holding": null}] |

None/unknown 不当作零；全部原始行、精确 tick/事件、PNG 哈希、逐球固定规则、里程边界见 opt2_report.json。首见允许早于该球开始。100cm 仅供方位候选；精确首见必须未封顶且唯一关联。末次离开失败不撤销已经验证的实际送达。600s 仅报告，不增加为阶段2硬门。

回归：

```json
{
  "previous_report": "/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/opt2_report.json",
  "previous_report_sha256": "b33b1f1b09e7d1dfe2644ceb4cdf43e8426cd14c36500b09379f2e894b1dd71e",
  "scope": "previous dual-delivery successful scenarios",
  "checks": [
    {
      "previous_scenario": "S04",
      "members": [
        "map-05"
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
