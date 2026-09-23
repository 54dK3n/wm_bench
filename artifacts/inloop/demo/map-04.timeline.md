# 首次看到的离线回溯

布局 map-04。100cm 封顶只形成方位候选，不提供距离证据。

| 平台目标 | 最早原始候选 | 最早无歧义未封顶 | 首次 WM 增量命中 |
|---|---|---|---|
| guangyang-target-2 | [34.36s / tick 1718 / lines[16]，55cm/-2.62°](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-017.vision/evidence-000441-tick-1718.png) | [34.36s / tick 1718 / lines[16]，55cm/-2.62°](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-017.vision/evidence-000441-tick-1718.png) | [34.36s / tick 1718 / lines[16]](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-017.vision/evidence-000441-tick-1718.png) |

精确渲染绑定问题：0；详情与全部候选见同名 JSON。

复跑：`python3 tools/demo_timeline.py /Users/ken/Desktop/wm_bench/artifacts/inloop/demo/map-04.json`
