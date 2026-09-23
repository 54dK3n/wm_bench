# 阶段 2 双球报告

已设门槛：FAIL / 未评估。独立场景双球送达 0/10；首次选择 0/10，已评估 0。

| 门槛 | 判定 |
|---|---|
| complete_ten_layouts_once | PASS |
| frozen_dependencies_unchanged | PASS |
| raw_trial_hashes_match_execution_ledger | PASS |
| no_regression_from_previous_successful_scenarios | FAIL / unknown |
| program_errors_zero | FAIL / unknown |
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
| P3_4_first_choice_matches_at_least_8_of_10_layouts | FAIL / unknown |
| successful_two_delivery_median_seconds_at_most_300 | FAIL / unknown |
| measured_turn_cost_k_pass_and_frozen | PASS |

| 布局/球 | 来源/真实目标 | 首见→确认→抓取→送达(s) | WM误差cm | observe/图像bytes | 全里程/道路/直线cm | 道路比 | 真值前/侧cm | 接近前/实际抓取视线夹角° |
|---|---|---|---|---|---|---|---|---|
| map-01/1 | new_observations/None (None) | None→None→None→None | None | 1/215503 | None/None/None | None | None/None | None/None |
| map-01/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-02/1 | new_observations/None (None) | None→None→None→None | None | 1/214534 | None/None/None | None | None/None | None/None |
| map-02/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-03/1 | new_observations/None (None) | None→None→None→None | None | 1/218186 | None/None/None | None | None/None | None/None |
| map-03/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-04/1 | new_observations/None (None) | None→None→None→None | None | 1/217949 | None/None/None | None | None/None | None/None |
| map-04/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-05/1 | new_observations/None (None) | None→None→None→None | None | 1/231513 | None/None/None | None | None/None | None/None |
| map-05/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-06/1 | new_observations/None (None) | None→None→None→None | None | 1/215685 | None/None/None | None | None/None | None/None |
| map-06/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-07/1 | new_observations/None (None) | None→None→None→None | None | 1/228247 | None/None/None | None | None/None | None/None |
| map-07/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-08/1 | new_observations/None (None) | None→None→None→None | None | 1/231503 | None/None/None | None | None/None | None/None |
| map-08/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-09/1 | new_observations/None (None) | None→None→None→None | None | 1/218085 | None/None/None | None | None/None | None/None |
| map-09/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |
| map-10/1 | new_observations/None (None) | None→None→None→None | None | 1/227810 | None/None/None | None | None/None | None/None |
| map-10/2 | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |

| 布局 | 双球通过 | 仿真s | 整局observe/图像bytes | 退出日志 |
|---|---|---|---|---|
| map-01 | False | 0 | 1/215503 | [] |
| map-02 | False | 0 | 1/214534 | [] |
| map-03 | False | 0 | 1/218186 | [] |
| map-04 | False | 0 | 1/217949 | [] |
| map-05 | False | 0 | 1/231513 | [] |
| map-06 | False | 0 | 1/215685 | [] |
| map-07 | False | 0 | 1/228247 | [] |
| map-08 | False | 0 | 1/231503 | [] |
| map-09 | False | 0 | 1/218085 | [] |
| map-10 | False | 0 | 1/227810 | [] |

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
      "passed": false,
      "failed_maps": [
        "map-05"
      ]
    },
    {
      "previous_scenario": "S09",
      "members": [
        "map-10"
      ],
      "passed": false,
      "failed_maps": [
        "map-10"
      ]
    }
  ],
  "regressions": [
    {
      "previous_scenario": "S04",
      "members": [
        "map-05"
      ],
      "passed": false,
      "failed_maps": [
        "map-05"
      ]
    },
    {
      "previous_scenario": "S09",
      "members": [
        "map-10"
      ],
      "passed": false,
      "failed_maps": [
        "map-10"
      ]
    }
  ]
}
```
