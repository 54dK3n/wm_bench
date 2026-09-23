# 阶段 2 第 1 轮：FAIL

完整十布局已执行完毕，每个布局仅执行一次。未进入阶段 3。

本页由 `python3 artifacts/inloop/opt-2/round-1/summarize_numbers.py` 生成。
所有门槛、逐球审计及原始日志行号见 [opt2_report.json](opt2_report.json)；
逐球完整表见 [AUTO_SUMMARY.md](AUTO_SUMMARY.md)，数值来源索引见 [numeric_evidence.json](numeric_evidence.json)。

| 退出条件 | 实测 | 判定与证据 |
|---|---|---|
| 双球送达 ≥8/10 | 2/10；独立场景 2/9 | FAIL；`runs[].platform_deliveries`、最终原生送达状态 |
| P3.4 首选最优 ≥8/10 | 9/10；独立场景 8/9 | PASS；`runs[].first_choice`（真值仅在 driver 评测中） |
| 双球成功局用时中位 ≤300s | 320.55s，原始值 [313.7, 327.4] | FAIL；原生最终 tick / 50 |
| 无回归 | 第一球成功场景回归 0；9/10 抓到第一球 | PASS；`regression_audit`。首次阶段2按阶段1的确认抓取成功比较；送达变化另列，不能称送达无回归。 |
| 固定规则、安全及预算 | 已抓 11 球逐球审计全部通过；approach 最大 1 次/球 | PASS；`balls[].fixed_rule_audit`，每球仍需3命中、不同位置、≥15cm间距、末点≥0.5m、纯记忆≥30cm、approach≤0.25m/max_steps=1 |
| observe ≤92、图像≤20MiB/局 | 最大 63 次、16789174 bytes（含关键帧） | PASS；`runs[].budgets` |
| 程序报错 / 原地重复 / guard违规 / 幻影CONFIRMED | 0 / 0 / 0 / 0 | PASS；`runs[].gate_details`、`first_confirmed_tracks` |
| 证据链完整 | 9/10 冻结证据门通过；map-08 有一次增量导出超时 | FAIL；错误保留，未重跑。最终原生PNG、samples、query逐项绑定均通过，详见 evidence-diagnosis。 |

P3.1：冻结的独立原生控制实验包括直行100cm×3及45°/90°/180°各3次；
名义 k=0.060290462706043484 cm/°，最大拟合残差0.4356663%。
既有真实任务118次控制的外部诊断最大残差23.5466%，21/118超过10%，
不能据此声称复杂路况的时间预测也达到10%。原始失败拟合未删除。
来源：[受控标定](../controlled-calibration/calibration.json)、[使用决策与独立场景依据](../constant-evidence/USAGE_DECISION.md)。

| 布局 | 双球送达 | 首选最优 | 用时s | observe | 图像bytes | 最终日志证据 |
|---|---|---|---|---|---|---|
| map-01 | False | True | 63.2 | 6 | 2099514 | [map-01.partial.txt:371](map-01.partial.txt) tick=3159 delivery: 未找到可确认的目标物存放姿态或释放未验证 |
| map-02 | False | True | 322.4 | 55 | 15432587 | [map-02.partial.txt:8633](map-02.partial.txt) tick=16120 constraint: navigation_queries_budget_exhausted |
| map-03 | False | True | 63.2 | 6 | 2154980 | [map-03.partial.txt:371](map-03.partial.txt) tick=3159 delivery: 未找到可确认的目标物存放姿态或释放未验证 |
| map-04 | False | True | 434.3 | 63 | 16789174 | [map-04.partial.txt:6758](map-04.partial.txt) tick=21714 constraint: navigation_queries_budget_exhausted |
| map-05 | True | True | 313.7 | 24 | 7462714 | [map-05.partial.txt:3054](map-05.partial.txt) tick=15686 delivery: None |
| map-06 | False | True | 510.6 | 49 | 12136822 | [map-06.partial.txt:9627](map-06.partial.txt) tick=25529 confirmation: WorldModel 未通过 observe() 确认目标物 |
| map-07 | False | False | 298.8 | 54 | 11890779 | [map-07.partial.txt:8948](map-07.partial.txt) tick=14938 confirmation: WorldModel 未通过 observe() 确认目标物 |
| map-08 | False | True | 379.9 | 59 | 15385760 | [map-08.partial.txt:12347](map-08.partial.txt) tick=18995 confirmation: WorldModel 未通过 observe() 确认目标物 |
| map-09 | False | True | 259.6 | 14 | 3974334 | [map-09.partial.txt:1339](map-09.partial.txt) tick=None constraint: navigation_queries_budget_exhausted |
| map-10 | True | True | 327.4 | 29 | 8404765 | [map-10.partial.txt:1535](map-10.partial.txt) tick=16369 delivery: None |

| 独立场景 | 布局 | 双球送达 |
|---|---|---|
| S01 | map-01 = map-03 | False |
| S02 | map-02 | False |
| S03 | map-04 | False |
| S04 | map-05 | True |
| S05 | map-06 | False |
| S06 | map-07 | False |
| S07 | map-08 | False |
| S08 | map-09 | False |
| S09 | map-10 | True |

合并沿用冻结的完整链接比较与容差，双球轨迹拼接后比较；本轮只有 map-01/map-03 合并。

未见位置只报告 E、G：
- E：n=2，map-05/球2 2.7298cm（确认日志行2908）；map-09/球1 10.3272cm（确认日志行879）
- G：n=1，map-10/球2 0.9938cm（确认日志行1208）

这些样本不足以作全面泛化结论；其余位置仅逐球报告。

程序与证据身份：

- PROGRAM_VERSION：`wm-opt2-r1-20260924`
- 文件 SHA256：`203e7a8acfa041064f341b6103b1fda4f80cc64b304ca3ae628e34844d79ca0e`
- 原生实际执行 sourceCode SHA256：`e0de6c25cc6a9d82de674f0ce892fbb45b24f1bf7d8a9a681209037654e04b34`（executed_program.py，原文件末尾换行被平台去除）
- wm_kit 提交：`326a5f8892b9da11996b5f3d3d0fc56341aca6e4`
- 嵌入包 SHA256：`61308c1c20270ec31d8ee5870ed2b01bf6920075e4820e5fc8c30bd2e626f1fb`
- 92 项冻结文件在批跑后校验一致；副本见 frozen_sources/INDEX.json。
- 运行前323项测试通过；指定五类 pylint 错误为0（tests.txt、pylint.txt、preflight.json）。
- 无布局坐标/真值/mission target锚点访问，静态检查通过；赛题1未运行。
- 改动与常量依据见 [CHANGES.md](CHANGES.md)、[PRE_RUN_SUMMARY.md](PRE_RUN_SUMMARY.md)。
- 阶段1过滤测试集已污染的披露继续有效；本轮不是新的无污染过滤验证。
