# 阶段 2 第 3 轮：FAIL，达到三轮上限后停止

十布局各执行一次，全部结束后统一评估。双球送达未达到门槛，停止阶段2，不进入阶段3或阶段4。未启动赛题1。
完整门槛和逐球证据见 [opt2_report.json](opt2_report.json)；[逐球表](BALL_TABLE.md)列全部时间线、里程比与抓取几何，原自动汇总保留为 [AUTO_SUMMARY.md](AUTO_SUMMARY.md)。
本页和表格由同目录 summarize_numbers.py 从保存的报告、原生record和日志生成；数值索引见 [numeric_evidence.json](numeric_evidence.json)。

| 退出条件 | 实测 | 判定 / 证据 |
|---|---|---|
| 双球送达≥8/10 | 2/10；独立场景2/10 | FAIL；原生两个不同目标package_delivered及最终送达状态 |
| P3.4首选最优≥8/10 | 9/10，已评估9；独立场景9/10 | PASS；runs[].first_choice，未知不当匹配 |
| 成功局总用时中位≤300s | 289.51s；原生tick值[321.72, 257.3] | PASS；simulationEndTick×0.02，含最后离开动作；冻结判定器按平台0.1s字段得到289.5s，同样通过 |
| 无成功回归 | 0项；map-05/map-10继续双球送达 | PASS；保留第1轮成功基线，不让第2轮全体启动失败清空基线 |
| 程序报错 / 原地重复observe / guard违规 / 幻影CONFIRMED | 0 / 0 / 0 / 0 | PASS；逐局gate_details及first_confirmed_tracks |
| 固定规则、安全与approach预算 | 11个已抓球逐球通过；approach最大1次/球 | PASS；balls[].fixed_rule_audit；onRoad全程通过 |
| observe≤92与全部视觉≤20MiB/局 | 最大47次 / 12294693bytes，含抓送关键帧 | PASS；runs[].budgets |
| 证据完整与冻结 | 10/10原生证据通过；105项冻结文件未变 | PASS；逐PNG/query/record/终端字节及SHA核验 |

全轮共12条首次CONFIRMED轨迹，11球确认并抓到、9球完成送达；第一球抓取9/10。
总observe=280；原生PNG=302张/70274049bytes，关键帧=20张/3478459bytes；samples=29397。重复封存副本不重复计入单局视觉预算。

全部机读门逐项列出（包括只有报告、不能替代双球退出条件的检查）：

| 检查 | 判定 |
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
| two_target_delivery_at_least_8_of_10_layouts | FAIL |
| P3_4_first_choice_matches_at_least_8_of_10_layouts | PASS |
| successful_two_delivery_median_seconds_at_most_300 | PASS |
| measured_turn_cost_k_pass_and_frozen | PASS |

| 布局 | 双球送达 | 首选最优 | 仿真s | observe / 全图像bytes | 最终任务项 | 失败/结束日志原值 |
|---|---|---|---|---|---|---|
| map-01 | FAIL | True | 206.96 | 6 / 2097572 | 0/13 | [L683](map-01.partial.txt) nativeEndTick=10348; ball=1; constraint: navigation_queries_budget_exhausted; Q=1000,C=74 |
| map-02 | FAIL | True | 454.54 | 20 / 5920225 | 3/13 | [L3479](map-02.partial.txt) nativeEndTick=22727; ball=2; constraint: navigation_queries_budget_exhausted; Q=1000,C=300 |
| map-03 | FAIL | True | 203.64 | 34 / 8393095 | 2/13 | [L774](map-03.partial.txt) nativeEndTick=10182; ball=2; confirmation: WorldModel 未通过 observe() 确认目标物; Q=507,C=137 |
| map-04 | FAIL | True | 265.32 | 38 / 9378831 | 1/13 | [L1873](map-04.partial.txt) nativeEndTick=13266; ball=2; confirmation: WorldModel 未通过 observe() 确认目标物; Q=574,C=153 |
| map-05 | PASS | True | 321.72 | 24 / 7311060 | 2/13 | [L2292](map-05.partial.txt) nativeEndTick=16086; ball=2; delivery: None; Q=748,C=197 |
| map-06 | FAIL | True | 290.98 | 40 / 9816772 | 5/13 | [L2251](map-06.partial.txt) nativeEndTick=14549; ball=2; confirmation: WorldModel 未通过 observe() 确认目标物; Q=602,C=175 |
| map-07 | FAIL | False | 151.66 | 26 / 5667316 | 0/13 | [L240](map-07.partial.txt) nativeEndTick=7583; ball=1; confirmation: WorldModel 未通过 observe() 确认目标物; Q=245,C=86 |
| map-08 | FAIL | True | 254.32 | 47 / 12294693 | 1/13 | [L1740](map-08.partial.txt) nativeEndTick=12716; ball=2; confirmation: WorldModel 未通过 observe() 确认目标物; Q=618,C=153 |
| map-09 | FAIL | True | 284.66 | 15 / 4207049 | 2/13 | [L1445](map-09.partial.txt) nativeEndTick=14233; ball=1; constraint: navigation_queries_budget_exhausted; Q=1000,C=130 |
| map-10 | PASS | True | 257.30 | 30 / 8665895 | 3/13 | [L1540](map-10.partial.txt) nativeEndTick=12865; ball=2; delivery: None; Q=676,C=190 |

表中总任务项仅报告，不把本阶段双球成功等同全赛题完成。

失败分组按最终日志原因计数：

- `navigation_queries_budget_exhausted`：3局，map-01、map-02、map-09。
- `WorldModel 未通过 observe() 确认目标物`：5局，map-03、map-04、map-06、map-07、map-08。

逐条运动归因见 [motion诊断](final-motion-diagnosis/REPORT.md)，确认/WM归因见 [WM诊断](final-wm-diagnosis/REPORT.md)，完整证据核验见 [证据审计](final-evidence-audit/REPORT.md)。

| 独立场景 | 布局 | 双球送达 |
|---|---|---|
| S01 | map-01 | False |
| S02 | map-02 | False |
| S03 | map-03 | False |
| S04 | map-04 | False |
| S05 | map-05 | True |
| S06 | map-06 | False |
| S07 | map-07 | False |
| S08 | map-08 | False |
| S09 | map-09 | False |
| S10 | map-10 | True |

沿用冻结的完整链接合并与容差，并比较两球目标片段。本轮每局目标片段均非空；map-03已进入第二球，map-01未进入，两局不再合并。未为提高比例调整分组。

未见位置精度只列E/G；其余位置只在逐球表报告：

- E：n=2；map-05/球2 7.3024cm（JSON原始行索引1214）；map-09/球1 10.3272cm（JSON原始行索引965）
- G：n=1；map-10/球2 1.0188cm（JSON原始行索引1217）

样本量有限，不外推全面泛化。P3首选匹配也不代表双候选排序已得到充分实战覆盖，候选数量与未知代价限制见WM诊断。
k沿用第1轮冻结的控制实验，不再拟合。名义控制拟合通过，复杂道路时间预测的外部残差限制继续披露，见 [使用决策](../constant-evidence/USAGE_DECISION.md)。
阶段1过滤测试集在规则修改后已污染的披露继续有效，本轮不能当作新无污染过滤验证。

版本与运行前检查：

- PROGRAM_VERSION：`wm-opt2-r3-20260924`
- 文件SHA256：`59d8f617a7fd82135b710b6a32cf112b4c17c80aa770beb59407aa50d5cf17e6`
- 实际执行sourceCode SHA256：`efc98999788c8f41c5c2d8023d839c85172c35e802dc2be390ab2a94f6e057a0`；executed_program.py与运行字节一致，平台删除原文件末尾换行。
- wm_kit提交：`326a5f8892b9da11996b5f3d3d0fc56341aca6e4`
- 嵌入包SHA256：`61308c1c20270ec31d8ee5870ed2b01bf6920075e4820e5fc8c30bd2e626f1fb`
- 396项Python测试、19项Node测试通过；23项预检通过。指定pylint错误0，无布局坐标/真值/target锚点访问。
- 第2轮启动错误保留为失败轮；本轮只修正作用域并新增完整worker启动测试。详见 [CHANGES.md](CHANGES.md) 与 [启动诊断](../round-2/startup-diagnosis/DIAGNOSIS.md)。
- 冻结源码副本及索引在frozen_sources/；全部原始日志、samples、record、PNG在本目录与attempts/中。

```sh
python3 artifacts/inloop/opt-2/round-3/summarize_numbers.py
```
