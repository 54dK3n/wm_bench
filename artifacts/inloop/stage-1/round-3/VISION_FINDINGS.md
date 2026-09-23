# Stage 1 / round 3 视觉证据审计

第三轮十局已结束。既有阶段评测为 **7/9 独立场景确认且抓到，FAIL**；达到三轮上限，阶段一停止。本审计只运行既有离线评测和读取原图，没有修改冻结脚本或机器人，没有追加仿真，也没有进入后续阶段。

## 完整性与复现

```sh
python3 tools/vision_diagnostics.py artifacts/inloop/stage-1/round-3 --reference-batch artifacts/inloop/v28r1_batch
node tools/vision_pixel_audit.js artifacts/inloop/stage-1/round-3
```

**133/133 observe** 的原生图像、query、程序日志和精确 renderTruth 绑定通过；原生检测器离线重算 **133/133 完全一致**。所有 **149 张原生 PNG** 均通过实际文件 SHA256、字节数、唯一 renderTruth、frameId/evidenceId/seq、tick/stateRevision 检查。全部拍摄 tick/revision 与原生证据 tick/revision 相同，挂钩错误为 0。真值直接来自相机渲染时的 camera matrixWorld 和对象快照，没有用附近 tick 的轨迹样本替代。

| 布局 | 原生 PNG | observe | 实际 PNG 字节 |
|---|---:|---:|---:|
| map-01 | 9 | 7 | 2,164,385 |
| map-02 | 6 | 6 | 1,561,634 |
| map-03 | 9 | 7 | 2,212,503 |
| map-04 | 11 | 9 | 2,657,083 |
| map-05 | 11 | 9 | 2,784,371 |
| map-06 | 12 | 10 | 3,043,170 |
| map-07 | 52 | 52 | 11,285,938 |
| map-08 | 11 | 9 | 2,792,174 |
| map-09 | 18 | 16 | 4,271,930 |
| map-10 | 10 | 8 | 2,435,908 |

十局总计 **35,209,096 字节**；最高单局 11,285,938 字节，小于原生每局 **20 MiB=20,971,520 字节**。另外 16 张图来自 observe 以外的原生视觉调用，也纳入预算、哈希及精确真值审计。各帧完整证据见 `vision_diagnostics.json`、`pixel_audit.json`；汇总及源码/产物 SHA256 见 `vision_audit_summary.json`。原生检测器源码 SHA256 仍为 `7627c0429e338f481948bdcb6ab59af901ad6ed0cee8001ef38d51dfa063c614`。

批跑结束时的 15 项冻结检验保持原样、全部 true。审计收尾时主任务单独修正了离线 `batch_report.py` 的文件匹配，将 `map-*.json` 收窄为 `map-??.json`，避免把第二轮新增的道路几何报告误当试验。`../postprocessing/audit.json` 保存旧/新哈希、单行差异及三轮重算审计：30 局汇总逐字段不变，60 份原始记录/样本及机器人源码共 61 文件哈希不变。视觉审计 JSON 分别记录历史冻结和当前该工具的差异，没有覆盖历史冻结清单。

## map-07：两个命中均来自粉红地标，未确认

真实 E 的早期检测仍与前两轮一致：tick3045、3058、3597、3683（两条）、3908、4005 共 7 条 raw target 都为 100 cm。近距离被屋顶遮挡后只剩 24/16/14 px 宽的红色片段；原生检测器按红区域宽度反算距离，仍然封顶。

tick3778 相机到 E 真值 **63.33 cm、−6.22°**，raw 红球为 0，是本轮唯一满足“30–85 cm、|bearing|≤30°、无 raw 红球”的应见未见帧。原图建筑覆盖目标方向，检测器中间结果红色候选区域数为 **0**，不是在后续置信度/区域抑制时删除。

![map07 tick3778 原生图](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/attempts/attempt-017.vision/evidence-000997-tick-3778.png)

后续 observe49/51 在两个不同位置，把同一个粉红导航地标当成目标送入 WM：

| observe / tick | raw (cm, deg, confidence) | 原图红区 (x,y,w,h) | 红色/亮种子计数 | 最近真红方位差 | WM |
|---|---|---|---|---:|---|
| 49 / 13133 | 58,−24.56,0.83 | (106,172,48,38) | 226 / 155 | 45.12° | hit 1，(1.117,0.903) |
| 50 / 13340 | 100,+1.65,0.82 | (324,188,16,12) | 22 / 20 | 46.55° | 未增加命中 |
| 51 / 13418 | 69,+0.55,0.81 | (306,176,36,26) | 93 / 26 | 47.33° | hit 2，最终(1.096,0.921) |
| 52 / 13817 | 100,−0.41,0.84 | (310,178,14,24) | 44 / 18 | 33.84° | 未增加命中 |

这些区域均通过尺寸/亮种子/前3区域筛选，无 zone suppression。图中物体清楚是粉红导航地标，真实红球处于完全不同的方向。tick13133 真 F 为 **123.45 cm,+20.56°**，真 E 为 **114.97 cm,+98.60°**；tick13418 真 F 为 **121.03 cm,+47.88°**，真 E 为 **97.94 cm,+133.85°**。

![map07 第一次伪红命中](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/attempts/attempt-017.vision/evidence-003567-tick-13133.png)

![map07 第二次伪红命中](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/attempts/attempt-017.vision/evidence-003665-tick-13418.png)

最终 `confirmation_failed:all_viewpoints_tried_or_unreachable,hits=2`，继而正常 `flow_end(success=false,stage=confirmation)`；navigation_queries=525、navigation_controls=124、grab=0、program_error=0。最终伪轨迹距最近真球 **89.7 cm**，超过预设关联上限 30 cm，必须记为“无对应真球”，不能算作 E 的误差样本。不同车位和同 track_id 的一致性不足以排除稳定地标伪红。

## map-09：真实 E 确认、接近并抓到，投放未完成

有效轨迹始终关联 E。确认记录列出三个不同车位，raw 分别为 **69 cm/−0.83°/0.92、60 cm/−2.62°/0.94、66 cm/−3.17°/0.91**，对应 tick3752、4267、4489。相机真值分别为 **81.95 cm/−0.81°、70.26 cm/−2.49°、80.44 cm/−3.12°**。WM 的计数另作区分：初次 tick3453 的 64 cm 观测已记 hit1；tick3752 与该位姿仅相隔 13.4 cm，未增加 WM 计数或平均权重；tick4267/4489 分别增至 hit2/hit3。WM 最终 `target_001=(-0.445,1.589)`，误差 **10.3 cm**。

原先第二轮没有进入的 lower-east，本轮已成功进入：`approach_memory_stop` 在该路、onRoad=true、WM 距离 0.242 m；再前进 2.2 cm 后在 **0.221 m** 停下。最后一次确认 observe 后累计前进 **475.6 cm**，才调用一次 `approach(max_steps=1)`。该调用仅转向 2.875°，返回 False（stop_step_limit），随后由抓取循环完成抓取。

这是 approach 最后一张原生相机图（tick7953），并非抓取瞬间补拍图：相机到 E 真值 **26.00 cm、+8.63°**；原生 target 距离估计为 `2.1447738576` 内部单位，即 **26.81 cm**。真实红包裹在画面内，后续没有额外相机帧。

![map09 tick7953 抓取前原生图](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/attempts/attempt-005.vision/evidence-002035-tick-7953.png)

| 抓取 | 原生 tick | 结果 | 抓取瞬间车体真值前向 | 侧向（右正） |
|---|---:|---|---:|---:|
| 1 | 7977 | far | 31.1 cm | +3.9 cm |
| 2 | 8042 | far | 25.1 cm | +3.9 cm |
| 3 | 8107 | far | 19.1 cm | +3.9 cm |
| 4 | 8172 | **grabbed** | **13.1 cm** | **+3.9 cm** |

四次都有同 tick 原生轨迹真值和平台 interaction 事件。前三次各前进 6 cm 后重试，第四次平台 `package_grabbed` 明确记录 `guangyang-target-2`、objectRole=target。抓取前 WM 认为前向约 22.1 cm，实际首抓前向 31.1 cm，与最终 WM 10.3 cm 的位置偏差一致；不能把四次尝试解释为抓错目标。

此后已经进入 delivery_phase，最后 `flow_end(stage=delivery,success=false,holding=目标物,reason=未找到可确认的目标物存放姿态)`。因此**确认且抓到成功，投放失败**，两者分开报告。本局总 navigation_queries=326、navigation_controls=108、program_error=0。

## 新证据：真红被清理点框抑制，伪红保留

map09 observe12/tick3680 的 E 真值 **88.65 cm、−0.17°**，原图中红包裹可见。像素检测器先形成合格红区 **(302,192,32,22)**，165 个红像素且全部为亮种子，距离/方位本应为 **77 cm、−0.28°**。

![map09 tick3680 真红被抑制](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/attempts/attempt-005.vision/evidence-000959-tick-3680.png)

但是它与 `cleanup-zone` 框 **(314,188,22,26)** 重叠，被 `vision-pixel-core.js:685–695` 的 zone suppression 删除。这里所有框已从 640×640 letterbox 换回 640×480 原图坐标。另一块粉红地标区域 **(242,182,12,14)**、26 红像素/20 亮种子没有被抑制，最终输出 **100 cm、−9.83°、0.86**。原生 query 同时输出 cleanup-zone **95 cm、+0.69°、0.86**，离线重算完全一致。

这是一条有原图、候选框及抑制阶段证据的独立失败机制：不是相机没看到红目标，而是真红候选在后处理中被清理点框覆盖。因真实距离 >85 cm 且仍有伪 raw 红，此帧不会被“30–85 cm 且 raw 无红”的应见未见规则计数，故在此另列。不能由此推断旧 tick1929 一定同因。

## 统计口径和停止状态

本轮筛查为 **1 张应见未见、12 张方位条件伪红候选图**。候选图不是 12 个虚构物体：map01 tick4015 与 map09 投放阶段 tick10600 是同类近场裁切例子，真实红包裹中心在相机 **5.69 cm、−68.82°**，只剩边缘红面，框中心却输出 −33.29°。其余候选及原图索引保存在 `vision_diagnostics.html`，map07 稳定地标伪红与 map09 区域抑制已按原图和中间结果定性。

**E/G 测试精度只计有效关联的已确认轨迹：E n=1（map09），最终误差 10.3 cm；G n=0。** map07 的 89.7 cm 最近邻距离是“未关联”证据，不是 E/F 的精度；A/B/C/D/F 不进入测试精度结论。第二、三轮重复 E 不是新增独立位置，不能合并成 n=2 的独立测试。

旧 v28r1 map04/05/08 tick1929 仍缺原始 PNG。第三轮最近的新帧与其相差 **19.97 cm、1.80–1.92°**，不满足 ≤1 cm/≤1° 的同等几何定义；旧原因保持 **unknown**，不把新图或新机制冒充旧帧证据。

独立场景 7/9 未达到既定至少 8/9 的阶段一门限。三轮上限已到，本次报告是停止后的证据整理；无第四轮、无额外布局仿真、无后续阶段结果。
