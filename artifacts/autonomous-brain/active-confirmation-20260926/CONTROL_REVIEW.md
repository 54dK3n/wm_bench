# 控制修复审阅入口

本说明对应冻结源码 `dec5b078d6711bdfda972ca4632c200e235dfb7e`，开发基线为 `6937605`。内容依据本轮源码、测试和 `raw/navigation/` 开发输出整理。以下均为离线合成公开传感输入测试；命令参数调用冻结平台的真实 `normalizeCommand` 校验，运动响应由测试脚本提供，不运行机器人仿真或模型。本说明没有读取正式局 truth、record 或评测结果，也不据此推断正式局表现。整理文档时未重跑测试或修改源码。

**审阅顺序与源文件**

1. [actions.py](../../../autonomous_brain/actions.py) 的 `_follow_approach_path`：短段聚合的授权终点与剩余弧长同步。
2. [navigation.py](../../../autonomous_brain/navigation.py) 的 `RoadMemory.approach_candidates`，以及 `Actions._road_reposition`：相关失败路线先过滤，随后截取最多三个候选。
3. `Actions._semantic_explore_result` 与 `explore`：用真实道路账本重新分类探索结果；共用的 `recover_unobserved_junction`、`return_from_blocked_road` 未改动。
4. [run.py](../../../autonomous_brain/run.py) 的 `compact_action_result`：向下一轮保留小型 `road_progress` / `target_progress` 证据；完整原始运动与道路账本仍单独保留。

**短段聚合：相同授权窗口必须使用相同剩余弧长**

原代码聚合连续样本后更新了 `execution_end`，但总量仍小于 10 cm 时，基础前进分支继续使用首段的旧 `remaining`。例如 `[4,4]` 的授权终点已经是 8 cm，剩余量却仍为 4 cm，导致直线剩余距离核验拒绝。修复在更新聚合终点后执行 `remaining = available`，其后直线核验、执行计划和前进命令使用同一授权窗口。

[test_brain_route_contract.py](../../../tests/test_brain_route_contract.py) 中 `normalize()` 通过 Node 直接加载 [robot-bridge-contract.js](../../../workspaces/guangyang-platform/projects/car-python/robot-bridge-contract.js) 的 `normalizeCommand`。冻结契约要求 `follow_road.distanceCm >= 10`、基础前进/后退距离至少 0.1 cm；本轮未修改契约、平台或阈值。

| 输入或边界 | 断言 |
| --- | --- |
| `[4,4]`、`[6,3]`、`[2,2,2]` cm | 分别发出一次合法 `forward(8/9/6)`；一个预算单位；完整且仅一次登记对应的已走路段。 |
| `[6]` | 保留有历史直线证据、当前安全余量支持的合法短前进。 |
| `[30,6]` | 保留 `follow_road(20)`、`follow_road(10)`、`forward(6)`；前 20 cm 不提前消费首段。 |
| `[6,6]` | 保留合法连续聚合，不发送小于 10 cm 的 `follow_road`。 |
| `[4,4]`、`[6,3]`、`[2,2,2]`，当前余量不足或预算为零 | 不发运动、不消费任何路段；分别报告安全证据不足或预算耗尽。 |
| `[4,4]`，第一段终点为路口且没有出口对应 | 仅走完首段 4 cm；第二段保持待定，不能跨路口静默聚合。 |
| `[30]`，请求 20 cm 后脚本实际多走 12 cm | 即使命令合法，也不能把未按记录到达的路段记为完成。 |

聚合还保留原来的连续方向、内部路口和实际弧长核验。基础短前进仍须满足整个窗口的历史直线证据、新鲜道路余量、0.2 cm / 0.2° 一致性要求。曲路完整链另由同文件的 `test_curved_complete_route_passes_actual_parameter_normalizer` 检查；它同样是合成诊断。

**第四条 118 cm 路线：先过滤失败版本，再取三个**

[test_brain_navigation_candidate_filter.py](../../../tests/test_brain_navigation_candidate_filter.py) 的 `four_observed_routes()` 使用真实 `RoadMemory`，逐条发布公开观测和实际运动字段；每个运动请求也通过真实参数规范器。两个观测链只通过已记录的连续运动建边，不给相近样本补连接。

目标位于 `[0,1.5]` m。旧排序的前三个候选分别是 `[0,1.18]`、`[0,1.17]`、`[0,1.16]` m；另一个已观测候选为 `[0,1.15]` m，其路线弧长为 `39 + 39 + 40 = 118` cm，净位移为 115 cm。前三条路线在相同实质上下文下已有失败记录时，旧顺序先截取三条再过滤，得到空集；新顺序先调用原有版本/上下文失败判定，再排序、截取，因此保留第四条。

新增可选参数 `candidate_filter=None` 放在既有参数末尾，保留旧五个位置参数的调用方式。`_road_reposition` 对不支持新关键字的旧候选提供器保留调用兼容及原有失败防重；正式 `RoadMemory` 使用截断前过滤。过滤复用 [navigation_progress.py](../../../autonomous_brain/navigation_progress.py) 的 `approach_blocked`，没有用新帧号清空失败记忆。

5 项专属测试覆盖：截断前过滤；真实候选进入 `_road_reposition` 并执行；旧位置参数与三候选上限；跨次调用失败记忆；旧提供器兼容。执行正例断言选择的是 118 cm 候选，运动请求累计 118 cm，随后仍通过原视觉接近门。这里的 118 cm 是路线弧长及脚本累计执行量；候选坐标、实际停止位置仍按既有到达判据核验，测试不声称在真实平台精确重走一条曲线。

预算与防空转反例保持如下：第一次调用最多尝试三条；第二次只能尝试剩余一条；仅增加观测帧后不再尝试、无运动；修改相关新鲜几何事实后才允许重新评估。该反例的候选执行前置条件被脚本拒绝，因此预算仍是 `[45]`，并不假称消耗了实际运动。可执行正例沿用同一个 45 步导航预算对象，未新建额外预算。候选数量与尝试上限均仍为 3。

**探索结果：物理路口、语义节点与目标证据分开**

`next_junction_observed` 现在只能由道路账本证明：本次调用中新登记的完整有向 traversal 已结束；当前观测有有效 anchor；出发与到达的 canonical 节点均为 `confirmed` 且不同；该 traversal 被出发出口的 `completion_traversal_ids` 引用，出口状态为 `verified`。允许先前动作出发、在本次调用内完成的行程；先前已经完成的 traversal 不可重复充当新到达证据。`atNode=true` 加位移本身不满足此条件。

结果携带以下独立证据：

- `road_progress.schema = brain-explore-road-progress/v1`：起止观测、起止节点与 anchor 引用、新增/到达 traversal IDs、`different_node_verified`、当前 `on_road` / `at_node`、净位移和里程计变化。`exit_entered` 来自本次窗口内已记录的 `take_exit` 运动段，不等于完整到达。
- `target_progress.schema = brain-explore-target-progress/v1`：`target_category`，以及 `new_target_object_ids`、`newly_confirmed_target_ids`、`new_other_object_ids`、`newly_confirmed_other_object_ids`。任务目标和其他类别分列；这些字段不自行提升世界模型状态。

| 情况 | 结果语义 |
| --- | --- |
| 新完整行程连接两个不同的已确认节点 | `next_junction_observed`。 |
| 有已确认的同节点进展，包括完整自环 | `same_junction_progress_observed`；`different_node_verified=false`。 |
| 只是重新观察同一节点，没有可归属的新节点进展 | `same_junction_reobserved`，不声称成功到达其他节点。 |
| 物理上看到节点，但当前语义身份未确认 | `junction_identity_unresolved`。 |
| 当前节点身份可确认，但没有本次完整有向连接 | `road_node_observed_without_completed_traversal`。 |
| 受阻后回到一个观测节点 | `road_blocked_returned_to_observed_node`，原失败仍为失败。 |
| 新任务目标或其他物体证据 | `target_objects_observed/confirmed` 或 `other_objects_observed/confirmed`，道路进展另列。 |

[test_brain_explore_semantics.py](../../../tests/test_brain_explore_semantics.py) 的 15 项检查使用真实 Runtime/RoadMemory 接线和实际参数规范器，包含不同节点正例、1 cm 同结构位移反例、无出发证明的到达、同节点回访、自环、跨轮完成、旧 trip 不复用、恢复后完整到达/缺出发证明对照、旧相机帧/被拒绝运动，以及原 12 次道路步进上限。目标分类用例脚本化对象状态变化，只验证分类，不代替本轮其他发现/世界模型确认测试。

旧 `test_brain_actions.py`、`test_brain_junction_observation.py`、`test_brain_exit_alignment.py` 中有 11 个参数化用例原来把物理节点标志直接当成新节点到达。它们不提供完整 indexed ledger / traversal，因此仅升级结果断言为待定或更准确的受阻返回说明；原命令数量、顺序、距离、转角、恢复预算及失败边界检查均保留。通用恢复函数没有整体改变；`explore` 对其返回结果进行语义分类。

**已执行命令与统计范围**

以下记录是冻结前开发回归，集合有重叠，不能相加作为独立测试总数；正式最终离线门的总数以根报告为准。所有列出的通过合集均无 skip、无 deselect。

| 输出 | 范围和结果 |
| --- | --- |
| [first-red.txt](raw/navigation/first-red.txt) | 控制修复首次反例：8 FAIL / 13 PASS；6 个短聚合断言、2 个候选过滤断言失败。该输出保存的是当时逐步建立的 21 项集合，不是当前全部文件的测试数。 |
| [explore-first-red.txt](raw/navigation/explore-first-red.txt) | 最初 7 项新探索契约：7 FAIL。 |
| [explore-legacy-red.txt](raw/navigation/explore-legacy-red.txt) | 旧探索断言与初始新契约合集：11 FAIL / 87 PASS。 |
| [explore-legacy-fixed.txt](raw/navigation/explore-legacy-fixed.txt) | 更新旧结果语义后相同集合：98 PASS。 |
| [control-regression.txt](raw/navigation/control-regression.txt) | 控制及原导航相关 15 文件：187 PASS。 |
| [explore-boundaries-fixed.txt](raw/navigation/explore-boundaries-fixed.txt) | 扩展后的专属探索语义文件：15 PASS。 |
| [final-development-regression.txt](raw/navigation/final-development-regression.txt) | 最终本分支 19 文件合集：281 PASS；文件首行保留完整原执行命令。 |

控制 187 项合集实际命令：

```sh
python3 -m pytest -q tests/test_brain_navigation_candidate_filter.py tests/test_brain_route_contract.py tests/test_brain_route_evidence.py tests/test_brain_navigation_reposition.py tests/test_brain_route_progress.py tests/test_brain_road_clearance.py tests/test_brain_visual_standoff.py tests/test_brain_recovery_map_closure.py tests/test_brain_recovery_topology_audit.py tests/test_brain_semantic_road_evidence.py tests/test_brain_stage2_adversarial.py tests/test_brain_navigation.py tests/test_brain_reverse_completion.py tests/test_brain_road_node_locator.py tests/test_brain_observed_routes.py
```

旧探索语义 98 项合集，以及扩展后专属 15 项的实际命令：

```sh
python3 -m pytest -q tests/test_brain_actions.py tests/test_brain_junction_observation.py tests/test_brain_exit_alignment.py tests/test_brain_observed_routes.py tests/test_brain_explore_semantics.py
python3 -m pytest -q tests/test_brain_explore_semantics.py
```

最终本分支 281 项实际命令：

```sh
python3 -m pytest -q tests/test_brain_navigation_candidate_filter.py tests/test_brain_route_contract.py tests/test_brain_route_evidence.py tests/test_brain_navigation_reposition.py tests/test_brain_route_progress.py tests/test_brain_road_clearance.py tests/test_brain_visual_standoff.py tests/test_brain_recovery_map_closure.py tests/test_brain_recovery_topology_audit.py tests/test_brain_semantic_road_evidence.py tests/test_brain_stage2_adversarial.py tests/test_brain_navigation.py tests/test_brain_reverse_completion.py tests/test_brain_road_node_locator.py tests/test_brain_observed_routes.py tests/test_brain_actions.py tests/test_brain_junction_observation.py tests/test_brain_exit_alignment.py tests/test_brain_explore_semantics.py
```

测试文件在红测之后继续增加边界用例，因此重跑当前文件不能期待得到旧开发快照的同一测试数。上述命令未包含网络、模型或仿真启动；真实 `normalizeCommand` 的 Node 子进程仅执行参数校验。机器可读范围摘要见 [development-summary.json](raw/navigation/development-summary.json)。
