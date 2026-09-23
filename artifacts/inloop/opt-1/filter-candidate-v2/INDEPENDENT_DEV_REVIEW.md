# v2 开发来源独立复核

只读复核：PASS。本报告只使用标定采集与 v28r1 开发资料；未使用 v2 测试回放。规则选择已受到 v1 测试反馈影响，不能恢复“未见测试”口径。

40≤distanceCm<90 为原 WM 接纳窗口合同复用，不应称为新证实的 M5 校准有效域；0.84/0.80 与 v1 完全相同，没有重拟合。

| 类别 | 原始 真/假/未知 | v2过滤 真/假/未知 | 已标误杀 / precision | 相对v1新增保留 假/未知 |
|---|---:|---:|---|---:|
| red | 121/33/152 | 0/3/1 | 0/121；3/3 | 8/16 |
| blue | 111/491/245 | 0/23/9 | 0/111；23/23 | 45/20 |

红precision仅3条已标伪例、蓝23条；过滤unknown分别1/9，不能作伪检测。若这些未知全是真例，precision下界分别75%、71.875%。旧baseline拒绝0，precision仍undefined。

| 证据组 | 三个原始行的距离/方位/confidence | 最小两两观察位置间距cm | 完整轨迹比较 |
|---|---|---:|---|
| window_false_red | calib_runs_v6/attempt-02.json:91 = 87/0.55/0.81；calib_runs_v6/attempt-08.json:77 = 43/-34.25/0.83；v28r1_batch/map-09.json:87 = 67/-13.13/0.81 | 98.321 | 三对均非等价 |
| window_false_blue | calib_runs_v6/attempt-03.json:3 = 82/-2.62/0.79；calib_runs_v6/attempt-05.json:56 = 58/25.24/0.74；calib_runs_v6/attempt-08.json:37 = 73/20.33/0.76 | 89.678 | 三对均非等价 |
| outside_true_red | calib_runs_v6/attempt-02.json:13 = 100/-17.49/0.89；calib_runs_v6/attempt-03.json:87 = 100/-1.52/0.85；calib_runs_v6/attempt-08.json:20 = 100/25.81/0.85 | 51.431 | 三对均非等价 |
| outside_true_blue | calib_runs_v2/attempt-01.json:5 = 35/-31.53/0.8；calib_runs_v6/attempt-03.json:74 = 100/28.32/0.85；calib_runs_v6/attempt-08.json:58 = 100/36.36/0.9 | 51.490 | 三对均非等价 |

每组已独立从原始日志重建类别首末检测之间全部observe帧（含空帧），去绝对tick/布局名后按旧stage1容差比较，并核验真实观察位姿。独立性不是由布局名称不同推得。

窗外真例全部原本就高于或等于置信度门，v1也会保留。因此这些例子只支持保留窗外观测的合理性，不能证明v2在dev救回真例：dev新增保留的是53条已标伪检测与36条未知，没有新增保留已标真检测。测试反馈污染和过滤能力减弱的代价已在开发文档明确列出。

原始行、完整轨迹核验与哈希见 [independent_dev_review.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/filter-candidate-v2/independent_dev_review.json)。未更改源码、规则、阈值或分组策略。
