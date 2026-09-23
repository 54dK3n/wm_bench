# 第3轮逐球表

None/unknown表示未发生或严格证据不足，不能当0。首见沿用冻结时间线的一对一、未封顶原始视觉对应；不把封顶方位线索当作定位证据。相机首见、WM接受首见与WM确认的完整归因见opt2_report.json及下方补充说明。

| 布局/球 | 位置 / 标定属性 / 来源 | 首见→确认→抓取→送达(s) | WM误差cm | grab尝试 | observe / 图像bytes |
|---|---|---|---|---|---|
| map-01/1 | B / 已用于模型选择 / new_observations | 13.50 → 42.92 → 55.76 → 未发生/unknown | 2.50 | 7 | 6 / 2097572 |
| map-01/2 | 未开始 | 未发生 | 未发生 | 0 | 0 / 0 |
| map-02/1 | C / 已标定 / new_observations | 35.70 → 65.16 → 93.24 → 129.50 | 5.44 | 7 | 6 / 2438868 |
| map-02/2 | D / 已标定 / new_observations | 188.66 → 196.70 → 未发生/unknown → 未发生/unknown（首见补充） | 5.33 | 0 | 14 / 3481357 |
| map-03/1 | B / 已用于模型选择 / new_observations | 13.50 → 42.92 → 55.76 → 86.32 | 2.50 | 7 | 6 / 2329321 |
| map-03/2 | 无对应真球 / 未评估 / new_observations | 未发生/unknown → 未发生/unknown → 未发生/unknown → 未发生/unknown | 未发生/unknown | 0 | 28 / 6063774 |
| map-04/1 | C / 已标定 / new_observations | 34.36 → 52.96 → 97.94 → 141.44 | 2.71 | 2 | 8 / 2832159 |
| map-04/2 | 无对应真球 / 未评估 / new_observations | 未发生/unknown → 未发生/unknown → 未发生/unknown → 未发生/unknown | 未发生/unknown | 0 | 30 / 6546672 |
| map-05/1 | C / 已标定 / new_observations | 34.36 → 56.92 → 87.08 → 123.36 | 2.42 | 2 | 8 / 2960335 |
| map-05/2 | E / 未见过 / new_observations | 192.20 → 200.56 → 290.22 → 319.60 | 7.30 | 1 | 16 / 4350725 |
| map-06/1 | D / 已标定 / new_observations | 38.34 → 58.40 → 74.38 → 167.10 | 8.17 | 2 | 10 / 3393190 |
| map-06/2 | 无对应真球 / 未评估 / new_observations | 未发生/unknown → 未发生/unknown → 未发生/unknown → 未发生/unknown | 未发生/unknown | 0 | 30 / 6423582 |
| map-07/1 | 无对应真球 / 未评估 / new_observations | 未发生/unknown → 未发生/unknown → 未发生/unknown → 未发生/unknown | 未发生/unknown | 0 | 26 / 5667316 |
| map-07/2 | 未开始 | 未发生 | 未发生 | 0 | 0 / 0 |
| map-08/1 | C / 已标定 / new_observations | 34.36 → 56.92 → 81.62 → 117.90 | 2.60 | 2 | 8 / 2966393 |
| map-08/2 | 无对应真球 / 未评估 / new_observations | 未发生/unknown → 未发生/unknown → 未发生/unknown → 未发生/unknown | 未发生/unknown | 0 | 39 / 9328300 |
| map-09/1 | E / 未见过 / new_observations | 69.06 → 89.78 → 129.46 → 未发生/unknown | 10.33 | 12 | 15 / 4207049 |
| map-09/2 | 未开始 | 未发生 | 未发生 | 0 | 0 / 0 |
| map-10/1 | D / 已标定 / new_observations | 41.28 → 48.94 → 56.12 → 97.60 | 3.66 | 2 | 8 / 2786314 |
| map-10/2 | G / 未见过 / new_observations | 203.56 → 215.10 → 236.12 → 255.18 | 1.02 | 2 | 22 / 5879581 |

map-02球2首见补充：188.66s，raw.lines零基L1294/tick=9433；首次WM实际入库182.92s，观察L1040、hit1快照L1044。该首次入库帧含多个可对应D的红色读数，按冻结的一对一时间线规则存在歧义，故早于严格首见。
全局最早封顶方位候选35.70s；第二球分段最早封顶候选169.82s。旧时间线只枚举实际抓取/送达的物体，漏列未抓到的D；opt2_report.json原None及SHA保留，表内补充由保存的原始帧和真值离线复算，未运行仿真或修改判定门槛。详见 [WM诊断](final-wm-diagnosis/REPORT.md) 和 [补充JSON](final-wm-diagnosis/diagnosis.json)；输入SHA收录在numeric_evidence.json。

| 布局/球 | 确认末点→抓取：全道路里程 / 直线cm / 二者比 | 其中follow/take_exit cm / 与直线比 | 真值前向 / 侧向cm | 接近前视线 / 实际抓取视线与接近夹角° |
|---|---|---|---|---|
| map-01/1 | 59.50 / 48.71 / 1.22 | 40.60 / 0.83 | 11.44 / 1.20 | -40.20 / -40.23 |
| map-02/1 | 186.70 / 63.10 / 2.96 | 160.20 / 2.54 | 11.13 / -3.64 | 121.60 / 117.39 |
| map-02/2 | 未发生/unknown / 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown |
| map-03/1 | 59.50 / 48.71 / 1.22 | 40.60 / 0.83 | 11.44 / 1.20 | -40.20 / -40.23 |
| map-03/2 | 未发生/unknown / 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown |
| map-04/1 | 398.80 / 93.60 / 4.26 | 353.30 / 3.77 | 13.33 / -1.90 | 164.40 / 164.45 |
| map-04/2 | 未发生/unknown / 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown |
| map-05/1 | 270.90 / 60.49 / 4.48 | 257.90 / 4.26 | 13.45 / -1.61 | 103.30 / 103.26 |
| map-05/2 | 750.60 / 100.61 / 7.46 | 649.80 / 6.46 | 15.65 / -1.92 | 156.60 / 152.23 |
| map-06/1 | 129.30 / 71.70 / 1.80 | 122.60 / 1.71 | 11.82 / -4.74 | 116.60 / 110.65 |
| map-06/2 | 未发生/unknown / 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown |
| map-07/1 | 未发生/unknown / 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown |
| map-08/1 | 221.20 / 60.45 / 3.66 | 207.90 / 3.44 | 13.17 / -1.52 | 102.70 / 102.74 |
| map-08/2 | 未发生/unknown / 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown | 未发生/unknown / 未发生/unknown |
| map-09/1 | 206.50 / 73.82 / 2.80 | 168.40 / 2.28 | 13.08 / 3.90 | -45.80 / -42.86 |
| map-10/1 | 48.10 / 41.48 / 1.16 | 40.00 / 0.96 | 13.53 / 2.10 | 17.00 / 17.02 |
| map-10/2 | 178.80 / 66.45 / 2.69 | 145.00 / 2.18 | 14.23 / 0.00 | -88.70 / -88.71 |

全道路里程取原生odometry距离差，含fine及倒退等运动；本轮全程onRoad审计通过。另列只累计follow_road/take_exit的子项，该子项与直线比可能小于1，不能把它误称全部道路里程。未抓到球时确认到抓取的距离无终点，另在失败诊断报告到停止的距离，不能混写。
