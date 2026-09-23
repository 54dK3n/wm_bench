# 首次看到的离线回溯

布局 map-03。100cm 封顶只形成方位候选，不提供距离证据。

| 平台目标 | 最早原始候选 | 最早无歧义未封顶 | 首次 WM 增量命中 |
|---|---|---|---|
| guangyang-target-2 | [13.50s / tick 675 / lines[8]，46cm/28.74°](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-013.vision/evidence-000180-tick-675.png) | [13.50s / tick 675 / lines[8]，46cm/28.74°](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-013.vision/evidence-000180-tick-675.png) | [13.50s / tick 675 / lines[8]](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-013.vision/evidence-000180-tick-675.png) |

精确渲染绑定问题：0；详情与全部候选见同名 JSON。

复跑：`python3 tools/demo_timeline.py /Users/ken/Desktop/wm_bench/artifacts/inloop/demo/map-03.json`
