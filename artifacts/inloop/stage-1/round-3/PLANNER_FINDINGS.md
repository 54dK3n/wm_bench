# Round 3 停止后的离线规划诊断

本轮阶段 1 为 **7/9，FAIL**，已到三轮上限。本文件仅解释现有结果；没有修改运行程序、现有评测脚本，也没有新增仿真。所有 `lines[n]` 均指原始 `map-NN.json` 中 **从 0 开始**的 `lines` 数组索引，不是 JSON 文件文本行号。源码行号另以 `program.py:L...` 标识。

结论：**02 的确认与 WM 没有退化；失败发生在接近规划。** 全道路方向阻塞的表达把局部避障扩大为全边不可达，最后连已走过的退路也删除。未知边界的 gateway 规划还有“从另一端进入、返回原落点”的实际循环。**09 的抓取改善发生在动态封边之前**，直接可见的区别是探索顺序和入口选择提前把车辆带到 `lower-east` 捕获范围，不能把成功归功于尚未触发的动态封边逻辑。

## 1. 结果和可比范围

| 布局 | 轮次 | WM 关联 / 最终误差 | 确认后道路里程 | 道路规划选择 / take_exit 次数 | 抓取 | 最终 flow_end |
|---|---|---|---:|---:|---:|---|
| 02 | R2 | C / 5.4cm | 1311.9cm | 94 / 17 | 第 2 次抓到 | success=true，delivery；mission 3/13 |
| 02 | R3 | C / 5.4cm | 1916.0cm | 110 / 29 | 0 次 | success=false，grab；mission 1/13 |
| 09 | R2 | E / 10.3cm | 3291.8cm | 177 / 48 | 0 次 | success=false，grab；mission 2/13 |
| 09 | R3 | E / 10.3cm | 473.4cm | 26 / 8 | 第 4 次抓到 | success=false，delivery，仍持有目标；mission 2/13 |

里程取 `approach_graph_memory_distance`：R2/02 `[937]`、R3/02 `[968]`、R2/09 `[1040]`、R3/09 `[998]`。动作计数范围是 `memory_confirmed` 之后、`delivery_phase_start` 之前，排除送达阶段。WM 关联、误差和 mission 与各轮 `stage_report.json/runs` 交叉核对。C 已参与标定，仅报告数值；E 是未见位置。

02 的 R2 `[752]` 和 R3 `[750]` 两个 `memory_confirmed` 事件除索引外**逐字段完全相等**：三次命中均为 `target_001`，位姿 `(-1.856,0.411)`、`(-1.933,0.230)`、`(-1.365,0.552)`，原始距离分别 63、77、51cm，最后点至 WM 为 0.560999046m。最终 WM 坐标同为 `(-1.590,1.066)`，见 R2 `[748]` / R3 `[746]`。

09 两轮最终 WM 坐标同为 `(-0.445,1.589)`，最后采样位姿、原始 66cm 和最后点至 WM 0.758253454m 相同，见 R2 `[694,698]` / R3 `[942,946]`。但第一条 accepted hit 及确认前探索不同，不能把两轮比较当作只改变单一规划分支的消融实验。

## 2. 02 的直接终止原因：全边封向删掉局部退路

公开图中 `central-south` 长 64.9cm，正向为 `node:central-north:end → node:central-south:end`。R3 原始事件如下：

| 索引 | 事件与数值 | 后果 |
|---|---|---|
| `[890–892]` | 选择 `central-south@0.0`；实际从另一端进入，在 progress=42.7cm 停于 `front_clearance`，动作总里程 37.7cm；记录整条反向 blocked | 当前局部受阻方向判定与实际进入方向相符 |
| `[893–894]` | 改为正向，42.7→49.3cm，实际移动 6.5cm，停于 junction | 第一次遇阻后能够沿来路退回 |
| `[964–966]` | 经 `middle-west` 从正向入口再次进入；在 progress=24.4cm 停于 `front_clearance`，动作总里程 40.0cm；记录整条正向 blocked | 两个整道路方向同时被封 |
| `[967]` | `memory_graph_exhausted`；WM 距离 1.587m，要求 0.300m；仍 onRoad=true | 立即判无剩余道路方案 |
| `[968–969]` | 1916.0cm 纯记忆道路里程；0 次抓取；查询 477 / 控制 173 | 未碰到 1000 / 300 配额上限，无程序异常 |

机制见冻结 [program.py:L1367](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/program.py:1367)：`blocked_directions` 只保存 `(fromNode,toNode,roadId)`，不保存阻塞位置或可退区间。[_vp_path:L1152](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/program.py:1152) 的同路路径和 L1165 的起始出口筛选都按整条方向拒绝。位于 24.4cm 时，去 0cm 的退路并不经过 42.7cm 处反向接近障碍的区域，却仍被第一次封向排除。

这不是“所有道路客观上都不可达”的证明。`take_exit` 刚从起始入口走到 24.4cm；前述来路在现有静态场景中已经实际通过。阻塞编码错误在**作用范围**，现有证据不支持把本例归为行驶方向符号算反。

离线抽取冻结 `_vp_path` / `dijkstra`，保持公开图及两个静态障碍道路 `middle-east`、`east-outer-south` 不变，可复现：

- 加入 `[891]` 和 `[965]` 两条整向阻塞，当前 `central-south@24.4`：去本路 0cm 的结果是 `None`，去 `oil-south@25` 也是 `None`。
- 仅在离线输入中移除 `[891]` 对反向的全边封禁，去本路 0cm 恢复为直接反向 24.4cm；去 `oil-south@25` 恢复为图成本 314.5cm，路径为 `central-north → north-east-main → bailu-west-arc → bailu-to-middle → oil-west-arc → oil-south`。

这是纯图函数的反事实检查，没有执行运动，也不声称该改动必然让 02 抓取成功。它证明最终的 `exhausted` 包含规划状态过度排除。

R2 则实际到达了该捕获道路：`[934–936]` 选择并进入 `oil-south`，落在 progress=25cm，实际 WM 距离 0.143m；`[943–944]` 第 2 次抓到 C。R3 确认后没有一次选择或进入 `oil-south`。已有日志没有保存每次未选 frontier 的完整分数，不能精确断言是哪一次排序独立决定了最终漏访；下面的 gateway 循环是可直接复现的额外缺陷。

## 3. 未知 gateway 的入口与 frontier 身份不一致

[_mag_frontiers:L2013](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/program.py:2013) 对没有坐标的端点使用 `enter_only=True`；[_vp_path:L1162](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/program.py:1162) 仍枚举目标道路两个入口，而 L1171 把末段统一记为进入该路的 25cm。于是“朝某个未知区间边界前进”的要求退化为“从任一端进入这条路即可”；保留的 key / frontier direction 却仍表示原边界。

02 有三组实际循环，循环守卫最终停止了重复动作，但也永久标记对应 frontier 失败：

| 目标 frontier | take_exit 事件 | 实际落点 | 最后拒绝 |
|---|---|---:|---|
| `bailu-outer-arc@0.0`，direction=+1 | `[759]`、`[766]`、`[768]` | 三次均为 160.2cm | `[769] repeated_road_state_without_new_route_progress` |
| `lower-east@97.3`，direction=-1 | `[896]`、`[898]` | 两次均为 25.0cm | `[899]` 同一理由 |
| `lower-west@0.0` | `[929]`、`[931]` | 两次均为 51.9cm | `[932]` 同一理由 |

第一组可用冻结纯函数精确复现：从 `bailu-outer-arc@160.2` 请求未知 0cm gateway，返回道路终点入口、落点仍 160.2cm、路线 `[bailu-outer-arc]`、成本 **50.0cm**。同一输入若按实际 0cm 停点计算，直接反向道路距离为 **160.2cm**。50cm 的规划没有推进到所请求的未知边界，日志 `[767–768]` 正是这次重入。该次 API 实际总运动 40.6cm，因 junction 在道路末端前提前触发；它也不是“0cm 没动”，而是移动后回到同一已测状态。

循环终止本身有效；问题出在 gateway 路径与 frontier 身份不一致，然后 [_approach_graph_navigation:L2119](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/program.py:2119) 把这次未推进永久折算为 frontier 失败。因此没有无限循环不等于已经完整探索可达区间。该问题也出现在 09：`east-outer-south@0.0` 最终被 `[964]` 同理由拒绝，成功局仍有这一额外绕行。

25cm 是公开 `take_exit` 的目标进入距离（平台 `competition-core.js:L117`、L3896–3910），不是本诊断拟合的参数。末段停点成本需计入该 API 落点，这件事本身正确；本例缺陷是 `enter_only` 改变目标语义后没有约束对应入口/未知区间。

## 4. max_distance 残差守卫不是 02 的直接失败原因

02 R3 `[822]` 请求 `east-inner-south@25.0`，道路距离 9.4cm；`[823]` 记录实际 24.8cm、目标 25.0cm 并 `replan`；`[824]` 补规划 0.2cm；`[825]` 路径成本归零；`[826]` 从 25.0cm 继续探索到 33.1cm。这个序列完成了残差恢复，没有把点永久判为 `max_distance` 不可达。

02 R3 的确认后 14 条 `viewpoint_unreachable` 全是 `stopped_before_candidate:junction`；`stopped_before_candidate:max_distance` 为 **0**，`repeated_travel_state` 为 **0**。3 次循环拒绝均来自上节 gateway 重入链，不是本次 0.2cm 残差。[_vp_travel:L1441](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/program.py:1441) 的“有进展则重规划”分支在这条实际轨迹中按预期生效。

另有保留限制：`junction` 先于指定端点触发时，该端点 frontier 会被判 `unreachable`。例如 `[763–764]` 到道路 185.2cm 端点仍差 15.6cm便停止。节点仍可供 `take_exit` 使用，因此这种局部停点失败也不能单独证明整条邻路不可达。

## 5. 09 从未抓到到抓到：先进入捕获道路，避开旧的错误失败链

R2：`[959]` 进入 `central-south` 在 24.4cm 停于 `front_clearance`。之后 `[962–963]` 把 `lower-east@0.0` 因 `transition_approach:front_clearance` 判为不可达；`[974–975]` 又把其另一端 `lower-east@97.3` 以同一过渡道路故障判失败。最终 `[1039]` WM 距离 0.653m、`memory_graph_exhausted`，全程没有抓取。两端失败并不证明 `lower-east` 本身受阻。

R3：`[973–976]` 从 camp 一侧进入 `east-inner-south`，落点 59.2cm；`[983–994]` 沿其已选方向探索到 15.6cm 一侧。`[995]` 选 `lower-east@0.0`，path=93.6cm，capture 下界=0，score=93.6cm；`[996]` 实际从另一端进入 `lower-east`，落点 **72.3cm**；`[997]` 当场测得 WM 距离 **0.242m ≤ 0.300m**，进入 fine 阶段。之后道路里程为 `[998]` 的 473.4cm，比 R2 少 2818.4cm。

`[1000]` fine 后 WM 距离 0.221m；`[1004–1007]` 连续抓取，累计推进 0、6、12、18cm，第 4 次持有目标。平台动作真值取现有 `stage_report.json`：抓取生效 tick=8172，目标 E 的前向/侧向为 **13.1 / 3.9cm**；程序 `[1007]` 的 tick=8186 是动作结束后记日志，二者不要混用。

R3 从 `[946] memory_confirmed` 到 `[1009] delivery_phase_start` 之间，`viewpoint_direction_blocked` **0 次**，`viewpoint_progress_replan` **0 次**。因此本局成功不能直接归因于动态阻塞修复或残差恢复；直接证据支持“改变后的探索顺序/入口代价使其提前进入 `lower-east`，无需走到旧的堵路分支”。启发项、gateway 语义和确认前缓存几何都同时变化，现有单次轨迹不能再分解各自贡献。

抓到不等于送达：`[1039] flow_end` 仍为 success=false、stage=delivery、holding=目标物，原因是未找到可确认的存放姿态。

## 6. 07 的最终 planner failure：只有两次同轨迹窗口命中

这里只报告规划与传感器事件，不解释红色类别来源，也不推测视觉误检成因。

- `[6316]` tick=13133，原始 target=58cm、bearing=-24.56°、confidence=0.83；`[6321–6322]` 收为第 1 次 hit。
- `[6651]` 选择 `lower-west@25.0`，预测 raw=77.55cm；`[6653–6654]` 实际 target=100cm、bearing=1.65°，窗口内 count=0、seen=1；`[6656]` 因无同轨迹窗口命中失败。
- `[6821–6823]` 再走 3.1cm 到 21.9cm，最终对准姿态相对上次观察仅平移约 3.1cm、转向 1.4°，守卫拒绝新增 observe；没有实际违规观察。
- `[6989–6997]` 再走 1.9cm 到 20cm，累计相对上次 observe 平移 5.0009999cm；tick=13418 的 raw=69cm、bearing=0.55°、confidence=0.81，获得第 2 次 `target_001` hit。两次 accepted hit 位姿相距约 20cm，WM 仍 tentative。
- `[7338]` `huangge-spur@25.0` 预测 raw=83.50cm；`[7340–7341]` 实际两个 target 均 100cm（bearing=33.49° / -0.41°），count=0、seen=2，没有喂入距离更新；`[7343]` 再次无同轨迹窗口命中。
- 最后一次候选枚举 `[8027–8195]` 共拒绝 169 个点：139 个预测在窗口外，24 个 already_tried，6 个与已有 hit 太近；其他拒绝原因 0。`[8196]` 候选数为 0；`[8197]` 报 `all_viewpoints_tried_or_unreachable`、hits=2；`[8199]` 正常以 confirmation 失败结束（查询525、控制124）。

这一最终理由表达的是已测候选和当前探索状态耗尽，不是对全图可观测性的证明。候选过滤、capped=100 不入 WM、运动守卫都能从日志看到；没有证据把末次失败归于 `max_distance` 残差或 02 的双向全边封禁。早先 `[6283]` 还存在独立的 hits=0 确认失败，本节没有把它与末次 hits=2 混合计数。

## 7. 复核方法与边界

新增 [extract_planner_findings.py](/Users/ken/Desktop/wm_bench/artifacts/inloop/stage-1/round-3/extract_planner_findings.py) 只读取冻结日志、stage_report 和平台源码，向 stdout 输出关键事件、索引、计数和纯图反事实结果。执行：

```sh
python3 artifacts/inloop/stage-1/round-3/extract_planner_findings.py
```

脚本不会启动 `DeterministicSimulator`、`NavigationActionRunner` 或任何运动 API。它仅 AST 抽取冻结程序中的 `dijkstra` / `_vp_path`；平台调用限于公开 `map_graph` 投影和用于复核道路锚点的静态几何。用于报告的场景身份、误差和动作真值来自已有报告/样本，不写回规划代码。

冻结 R3 `program.py` SHA256：`414b941ebc4c24fcf70a9384de90abc50c7e677e9f79103dc84b0861d567a69a`。平台 core 只读校验 SHA256：`54e004e8ff38188e5e08971a800722a779ef817a5471efd400bf22e52a42cd08`。本文件提供失败定位，不提出第四轮试跑，也不把离线反事实当成已验证修复。
