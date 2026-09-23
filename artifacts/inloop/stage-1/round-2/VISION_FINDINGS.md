# Stage 1 / round 2 视觉与道路几何诊断

本次只读取已完成的赛题 2 十局，没有启动仿真，没有修改机器人、driver、取帧挂钩或既有视觉评测代码。新增的 `tools/road_geometry_diagnostics.py` 只做离线几何计算；坐标和真值只进入诊断产物。

## 复现与完整性

```sh
python3 tools/vision_diagnostics.py artifacts/inloop/stage-1/round-2 --reference-batch artifacts/inloop/v28r1_batch
node tools/vision_pixel_audit.js artifacts/inloop/stage-1/round-2
python3 tools/road_geometry_diagnostics.py artifacts/inloop/stage-1/round-2 --map map-09
```

**125/125 observe** 的 PNG、原生 query、程序日志及精确 renderTruth 全部绑定成功。离线用平台原生 PNG 解码器和检测器重算，**125/125 查询结果完全一致**。全部 **141 张原生 PNG** 的实际文件字节、SHA256 与 native recorder 一致，均有唯一同次相机渲染真值；全部 captureTick=evidenceTick，captureStateRevision=evidenceStateRevision，挂钩错误为 0。真值来自原生渲染时的 camera matrixWorld、车体和对象快照，本轮没有以间隔采样姿态替代。

| 布局 | 原生 PNG | observe | 实际 PNG 字节 |
|---|---:|---:|---:|
| map-01 | 9 | 7 | 2,165,140 |
| map-02 | 9 | 7 | 2,239,794 |
| map-03 | 9 | 7 | 2,209,021 |
| map-04 | 11 | 9 | 2,654,863 |
| map-05 | 11 | 9 | 2,786,125 |
| map-06 | 12 | 10 | 3,040,700 |
| map-07 | 47 | 47 | 10,017,975 |
| map-08 | 11 | 9 | 2,789,706 |
| map-09 | 12 | 12 | 2,811,086 |
| map-10 | 10 | 8 | 2,439,301 |

总计 33,153,711 字节跨十局；最高单局 10,017,975 字节，小于每局原生 **20 MiB=20,971,520 字节**。另外 16 张图来自 observe 以外的原生视觉调用，也纳入全部字节及真值绑定审计。

检测器源码 SHA256 `7627c0429e338f481948bdcb6ab59af901ad6ed0cee8001ef38d51dfa063c614`；相机定义哈希 `88a9f8cc474d60a60e68fca46cb9e0d0bd5cffc86d1312fa481e8133d4b26600`；检测定义哈希 `f1f0ba40b9177bf93055579eaa0602e369a2bf8daaf522f98df3775df5a5dead`。`pixel_audit.json` 保存区域过滤中间值；`vision_focus_cases.json` 保存 map07/09 全 observe 原始序列、精确真值、确认/终止事件与抓取前路线统计。

## map-07：真实 E 始终封顶，最后接纳的是伪红

| observe / tick | E 相机真值 (cm, deg) | raw target (cm, deg, confidence) |
|---|---|---|
| 11 / 3045 | 101.37,−21.66 | 100,−22.60,0.86 |
| 12 / 3058 | 101.01,+2.11 | 100,+1.52,0.91 |
| 14 / 3597 | 73.23,−37.15 | 100,−35.45,0.88 |
| 15 / 3683 | 67.24,−6.39 | 100,−7.67,0.89；100,−4.68,0.83 |
| 16 / 3778 | 63.33,−6.22 | 无 |
| 17 / 3908 | 65.11,−2.08 | 100,−3.30,0.88 |
| 18 / 4005 | 61.86,−7.00 | 100,−5.09,0.91 |
| 47 / 12957 | 114.97,+98.60 | **伪红** 100,−26.14,0.87；**伪红** 88,−23.53,0.80 |

前 7 条 E 相关红色读数全部是 100。近距的 tick3683/3908/4005 只剩 24、16、14 px 宽的局部红区。检测器 `vision-pixel-core.js:529–536` 根据连通区域宽度反算距离并封顶；局部遮挡会让真实 62–67 cm 的目标也输出 100，而不是证明真实距离 ≥100 cm。tick3778 是本轮唯一“30–85 cm、|bearing|≤30° 但 raw 无红”帧，原图前景建筑覆盖目标方向，重算得到 **0 个红色候选区域**，不存在检测后才被置信度或区域抑制删除的情况。

![map07 tick3778 遮挡原图](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-2/attempts/attempt-006.vision/evidence-000997-tick-3778.png)

第一次视点尝试耗尽后 `confirmation_failed` 为 hits=0。继续巡逻，在 observe47/tick12957 把粉红导航地标识别为两条红球：

![map07 tick12957 伪红地标原图](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-2/attempts/attempt-006.vision/evidence-003489-tick-12957.png)

| 原图区域 (x,y,w,h) | 红色/亮红种子计数 | raw | 最近真实红球方位差 |
|---|---|---|---:|
| (106,178,20,28) | 98 / 44 | 100 cm,−26.14°,0.87 | 46.70° |
| (124,182,30,28) | 79 / 33 | 88 cm,−23.53°,0.80 | 44.09° |

两区均通过尺寸、种子数、前 3 区域筛选，也未被 zone suppression 去除。此时另一个真目标 F 在 **123.45 cm,+20.56°**；两条检测既不是 E，也不是 F。88 cm 被送进 WM，产生 `target_001`，坐标 `(1.271,0.613)`，校正距离 104.1 cm，只有 1 次命中。最终全部候选被拒，`viewpoint_candidates.count=0`，`confirmation_failed.reason=all_viewpoints_tried_or_unreachable,hits=1,failures=[]`。

最后是正常 `flow_end(success=false,stage=confirmation)`，navigation_queries=477、navigation_controls=121，平台没有 program_error。该 WM 位置距最近真实红球 **86.5 cm**，超过报告预设 30 cm 关联阈值，必须标为“无对应真球”，不能计入 E 的精度或确认成功。

## map-09：真实 E 确认成功，但没有执行抓取

| observe / tick | E 相机真值 (cm, deg) | E 的 raw (cm, deg, confidence) | 红区宽度 |
|---|---|---|---:|
| 9 / 3453 | 93.73,+35.19 | 64,+35.27,0.92 | 48 px |
| 10 / 3466 | 92.80,+0.11 | 87,−0.83,0.83 | 28 px |
| 11 / 4067 | 70.26,−2.49 | 60,−2.62,0.94 | 42 px |
| 12 / 4289 | 80.44,−3.12 | 66,−3.17,0.91 | 38 px |

tick3453 的目标位于右侧边缘，tick3466 前景橙色导航地标遮住红包裹的一部分，红区只有 28×28；后两张图中的真目标清楚可见。tick4067 还出现粉红地标伪红 `100 cm,−17.49°,0.80`，其区域为 (178,176,22,22)，最近真红方位差 15.00°；该条没有进入本次有效 WM 测距命中，WM 首次/最终都关联 E。

![map09 tick3466 局部遮挡](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-2/attempts/attempt-011.vision/evidence-000878-tick-3466.png)

![map09 tick4289 最后一次observe](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-2/attempts/attempt-011.vision/evidence-001085-tick-4289.png)

确认记录包含三个不同车位，WM 有效命中数 3；同一车位转向后的重复观测没有增加 WM 命中。最终轨迹 `target_001` 的位置 `(-0.445,1.589)` 关联真实 E，最终误差 **10.3 cm**。

之后没有新的 observe，因此不能提供所谓“抓取瞬间图”：本局 **robot.approach 调用 0，grab 调用 0**。`stage=grab` 的失败发生在接近前置条件：`approach_min_distance_failed(reason=memory_graph_exhausted,current_wm_distance_m=0.653,required_m=0.3,roadId=central-south,onRoad=true)`。最后一次 observe 后累计移动 3291.8 cm；保存的轨迹样本到 WM 最近 **47.85 cm**（tick5150），到 E 最近 **54.96 cm**（tick15435，终点仍为此距离）。这是保存样本上的最小值，未插值冒充连续轨迹极值。终止时 navigation_queries=831、navigation_controls=294，平台无 program_error。

## E 的 30 cm 道路候选集合并不为空

纯 driver 离线几何结果见 `map-09.road_geometry.json`。采用平台 `competition-core.js:1232–1251` 同样的道路折线距离和 `width/2−vehicleRadius` 规则，车辆半径为 **5.5 cm**，不向控制程序提供真值坐标。

| 位置 | 最近道路/段 | 最近中心线 progress | 距中心线 | 扣车半径后允许横移 | 该位置剩余横向净空 | 到扣半径道路区域距离 |
|---|---|---:|---:|---:|---:|---:|
| E | lower-east / 0 | 37.4525 cm | 0 cm | ±9.1875 cm | 9.1875 cm | **0 cm** |
| WM | lower-east / 1 | 45.9190 cm | 6.7768 cm | ±9.1875 cm | 2.4107 cm | **0 cm** |

lower-east 宽 **29.375 cm**。WM 半径 30 cm 与道路中心线相交的连续 progress 区间为 **15.4653–78.6566 cm**；E 对应区间为 **7.4525–68.6306 cm**。两者都有大量合法中心线位置，不需要越出道路才能接近。

作为局部几何存在性证明，沿 E 所在道路切向的两侧各取距 E 20 cm、14 cm 的车位，四个车位全部 onRoad，且与布局内全部已知物体圆盘（车半径+物体半径）无相交。20 cm 已满足 `approach≤25 cm` 的距离条件，14 cm 位置还在平台默认抓取前向距离上限 16.875 cm 内，侧向可对齐到 0。此证明说明“固定道路/接近距离限制使 E 天生不可抓”不成立；它没有证明从实际终点存在已规划出的无碰撞连接路径，也没有忽略目标自身占据的空间。

运行日志表明近目标路段没有成功进入：`lower-east@0.0`（规划路径 40.5 cm）和 `lower-east@97.3`（137.8 cm）都被 `viewpoint_unreachable:transition_approach:front_clearance` 拒绝。此前 `central-south@64.9` 也被 `stopped_before_candidate:front_clearance` 拒绝。应区分“入口受前向净空阻止/尚未探索”与“目标周围根本没有合法道路候选”；后者被本次几何计算排除。

## 候选图与 E/G 精度口径

本轮有 **1 张应见未见**、**5 张方位条件伪红候选图**。后者分别是 map01 近场边缘截断 1 张、map02 粉红地标 2 张、map07 粉红地标 1 张、map09 粉红地标 1 张。map01 的真红包裹中心已在相机 5.69 cm、−68.82°，只剩图边的红面，框中心输出 −33.29°；此例满足候选条件，但不应定性为虚构目标。其余地标例子由原图与检测中间区域共同支持。

只统计 **E/G、已确认且有效真值关联**：本轮仅 **map09 的 E，n=1，误差10.3 cm**；G 有效样本数 **0**，不能给出 G 精度结论。map07 的伪红轨迹不进入精度分母。A/B/C/D/F 只报告，不参与测试结论。

旧 v28r1 map04/05/08 tick1929 仍没有原生 PNG。round2 最近的新图仍相差 **19.97 cm、1.80–1.92°**，不满足 ≤1 cm、≤1° 同等几何条件；不以新图冒充旧图，也不据此给旧失败强行定性。
