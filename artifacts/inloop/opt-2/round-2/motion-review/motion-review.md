# 第2轮速度作用域与既有网格依据

独立只读审查 root 的 motion fragment 与 build 注入；不审查/修改本人送货实现，不运行仿真、不重复预检。可复算：[reproduce.py](reproduce.py) → [motion-review.json](motion-review.json)。native input / raw line 索引均零起始，源码行号一始。审查程序原始 SHA256：`90191e8764de3b98cd4251341f582a60e4b097e98453273bf5b5ab2eefe0a029`；motion fragment SHA256：`2f631a26980f83a6ca0839048bc64e5d5274d29c88643308787b980f186e0c27`。

## 静态结论

未发现速度开关泄漏到确认或 fine 的问题。`opt2_motion_fragment.py:10–17` 在调用原 `_approach_graph_navigation` 前开启标志，`finally` 恢复先前值，正常返回和异常均恢复。build 只把 `approach_target_with_world_model` 的该一次调用替换成 wrapper；fine 函数除了这次调用，其余 AST 与首轮完全相同。`_approach_graph_navigation`、`_mag_frontier_step`、`_record_hit`、`_confirmation_result` 的 AST 均与首轮相同。

精确速度范围：

- 记忆图行驶的 `_vp_travel` 定位/转路使用已有 `CRUISE_SPEED=100`；这包括向 frontier 的定位和 `enter_only` 未知入口转路，并非仅限于已测坐标区间。当前位置沿未知区间拓展的 `_mag_frontier_step` 仍显式 `_vp_follow(..., SLOW_SPEED)`（主程序2087附近）。两者不要混称为“未知路一律30”。
- 第一球巡逻的 follow 仍用传入30、enter 的标志为 false；第二球巡逻仅 `_opt2_patrol_follow` / `_opt2_patrol_enter` 用100。`_opt2_patrol_enter` 用 `finally` 恢复，巡逻后调用确认已在 wrapper 外。主程序1838/1842/1846为唯一巡逻速度替换点。
- 确认采样没有调用上述速度 wrapper；fine 的 `motion_forward/backward` 与原参数不变。送货后 `_demo_reset_ball` 会把 `DELIVERY_LOG.on` 置 false，再开始第二球，因此第二球确认不会继承送货标志。
- 100 是已有平台 **percent** 速度参数，遵守原 `obeySpeedLimit=True`；没有新增速度常量或经验时间阈值。这里不据静态代码保证提速后轨迹、成功率或时间门通过。

build 的 acquisition 桥接与计数/来源补查：3处真实 observe 后的 `_update_wm` 变成 `_opt2_update_observations`（主程序1796、1826、1855），2处巡逻 abort 判断改 helper；不创建额外 observe，也没有把 empty WM update 算作 observe。`_demo_reset_ball` 唯一新增本球起始 `ball_start_track_ids` 集合，`_demo_lock_target` 唯一新增按该集合重算 `target_source`；两处归一化后 AST 与首轮相同，保留全局 observe_count / last_observe_pose / NAV预算；lost-selection 清理只清选中轨迹的命中/规划状态。记忆目标失效后 fallback 的巡逻上限仍受 `min(MAX_OBSERVES, observe_count + PATROL_OBSERVE_BUDGET)` 限制。新目标锁定时来源仍由本球起始 WM IDs 判定，故失效后从新帧建立的轨迹记 `new_observations`，不沿用旧 `memory` 标签。完整异步执行由另一独立审查负责。

## 至少三个独立场景的原生道路控制依据

以下均为已结束首轮，**不是提速后预测**。记忆阶段从 `ball_confirmed.tick` 到 `approach_graph_memory_distance` 对应的原生 odometry 累积距离精确匹配终点。道路控制合计只含完整落在该区间的 native follow/take_exit；记忆总里程另含小步 drive，记忆总耗时另含转向，二者不能互相替代。`simulationDefinition.stepMs=20`。

| 独立场景/布局 | 第一球记忆 tick | 全 odom cm / 阶段秒 | 道路控制次数 / cm / 控制秒 | 速度 |
|---|---:|---:|---:|---:|
| S02 / 02 | 3258–4563 | 172.6 / 26.10 | 17 / 160.3 / 20.32 | 30 |
| S03 / 04 | 2648–5414 | 391.0 / 55.32 | 33 / 353.3 / 44.46 | 30 |
| S04 / 05 | 2846–4702 | 263.2 / 37.12 | 24 / 257.9 / 30.66 | 30 |
| S05 / 06 | 2920–3694 | 122.6 / 15.48 | 12 / 122.6 / 14.62 | 30 |
| S07 / 08 | 2846–4335 | 213.1 / 29.78 | 20 / 207.9 / 24.72 | 30 |
| S08 / 09 | 4464–5866 | 186.3 / 28.04 | 12 / 168.4 / 21.86 | 30 |
| S09 / 10 | 2447–2707 | 40.0 / 5.20 | 4 / 40.0 / 4.88 | 30 |

可定位控制例：02 native input179 tick3583，take_exit east-north-outer，40.6cm/254ticks；04 input130 tick2726，oil-west-arc，40.6cm/256ticks；05 input139 tick2999，bailu-outer-arc，40.6cm/247ticks；08 input139 tick2998，同道路40.6cm/248ticks，均 speed30。首轮已实际使用 speed100 的送货控制：02 input342 tick5487、04 input346 tick5996、05 input293 tick5281、08 input277 tick4915，各为 oil-west-arc 40.6cm/169ticks、obeySpeedLimit=true。后者说明100是已有并执行过的公共控制选择，不能把不同初始姿态/朝向的耗时当作成对速度实验，也不能据此线性外推节省比例。

第二球全部道路控制的原始数据与速度分组也在 JSON（包含全局输入索引）。此报告不把球2确认里的30速控制误称为全部可提速巡逻。

## 5cm停车去重证据：一例直接双扫，三例几何一致性

必须区分“发生了双扫”与“候选混用了不同粒度”。直接失败只有 **09/S08**：raw L1130–1165 在40.0cm扫36朝向，L1170–1205在39.9cm又扫36朝向，相距0.1cm，全部 wouldCompleteDelivery=false。L1127的39.9cm是走向40.0cm时的 max_distance 残差测量点。此证据来自已完成首轮，不是新增试验。

其余三个独立场景的公开数据如下：

| 场景/布局 | native mission 存放 progress | 实际选择 raw line | 实际preview | 既有5cm网格相邻点 | 间隔 |
|---|---:|---:|---:|---:|---:|
| S02 / 02 | 4.4cm（input0） | L869：4.4cm | 25次后成功 | 5.0cm | 0.6cm |
| S03 / 04 | 4.4cm（input0） | L517：4.4cm | 25次后成功 | 5.0cm | 0.6cm |
| S05 / 06 | 4.4cm（input0） | L657：4.4cm | 25次后成功 | 5.0cm | 0.6cm |

5.0cm是冻结首轮 `_opt2_storage_candidates` 对公开 road length 执行既有5cm网格生成式必然得到的候选；它不是这三局实际选中/扫描的日志值。三局在4.4cm成功即结束，所以 **均未扫描5.0cm**。相同公开存放锚点也不是三份不同存放几何。它们只证明“公开精确锚点/残差样本与5cm网格同时存在”的一致性，不能包装成三次重复扫描失败或三场新阈值有效性试验。

本轮新去重判定使用原有5cm停车粒度；该选择有1次直接重复失败和上述公开几何一致性依据，没有三次直接失败证据。若纪律要求的是三次直接失败验证，则当前证据不足，应如实保留限制。不能虚构布局失败来满足数量。
