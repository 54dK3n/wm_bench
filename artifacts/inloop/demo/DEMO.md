# 双目标 Demo

**map-05 通过**：同局两个不同目标确实抓取并送达，全部既定门槛通过。

| 球 / 实际包裹 | 来源 | 首次可确证看到 | confirmed | grabbed | delivered |
|---|---|---|---|---|---|
| 1 / guangyang-target-1 | new_observations | [34.36s / tick 1718 / lines[16]](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-030.vision/evidence-000441-tick-1718.png) | 56.92s / tick 2846 / lines[314] | 188.26s / tick 9413 / events[2] | 225.94s / tick 11297 / events[4] |
| 2 / guangyang-target-2 | new_observations | [328.08s / tick 16404 / lines[601]](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-030.vision/evidence-004149-tick-16404.png) | 337.38s / tick 16869 / lines[1014] | 398.36s / tick 19918 / events[5] | 439.06s / tick 21953 / events[7] |

首次看到采用未封顶、精确渲染且唯一匹配证据；更早的 100cm 候选若存在，仍只记为候选。首次 WM 关联另保留在 `demo_finalized.json`。

| 球 / 关键帧 | 平台事件 tick | 截图 tick | PNG |
|---|---:|---:|---|
| guangyang-target-1 / package_grabbed | 9413 | 9416 | [原图](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-030.demo/event-002416-package_grabbed-tick-9416.png) |
| guangyang-target-1 / package_delivered | 11297 | 11300 | [原图](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-030.demo/event-002861-package_delivered-tick-11300.png) |
| guangyang-target-2 / package_grabbed | 19918 | 19919 | [原图](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-030.demo/event-005026-package_grabbed-tick-19919.png) |
| guangyang-target-2 / package_delivered | 21953 | 21956 | [原图](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-030.demo/event-005506-package_delivered-tick-21956.png) |

仿真 440.6s；observe 27/92；原生视觉 7280389 bytes；合计图像 7976026 bytes（只报告）。

| 失败布局 | 原始日志证据（零起点索引） |
|---|---|
| map-03 | 实际已抓并保持送达=1（guangyang-target-2）；lines[3317] tick 12300：WorldModel 未通过 observe() 确认目标物; delivered=1, queries=379, controls=124；confirmation_failed lines[3281] {"hits":0}；末 observe lines[3314] count=33，红=[]；末 WM lines[284] target_001:confirmed/hit=3；未通过门槛（unknown=未核验）：two_distinct_targets_grabbed_and_delivered=fail,two_ball_timelines_complete=fail,every_ball_fixed_rules_pass=fail |
| map-04 | 实际已抓并保持送达=1（guangyang-target-2）；lines[10364] tick 25471：WorldModel 未通过 observe() 确认目标物; delivered=1, queries=840, controls=230；confirmation_failed lines[10348] {"hits":0}；末 observe lines[10361] count=54，红=[]；末 WM lines[267] target_001:confirmed/hit=3；未通过门槛（unknown=未核验）：two_distinct_targets_grabbed_and_delivered=fail,two_ball_timelines_complete=fail,every_ball_fixed_rules_pass=fail |

完整固定规则、原始日志与哈希见 [demo_report.json](demo_report.json)、[DETAILS.md](DETAILS.md)；首次看到与首次 WM 命中的区别及全部候选见 [demo_finalized.json](demo_finalized.json)。不计算成功率。

复跑：

```sh
python3 tools/reproduce_demo.py --demo-folder /Users/ken/Desktop/wm_bench/artifacts/inloop/demo --out /tmp/wm-demo-reproduction-NEW
```
