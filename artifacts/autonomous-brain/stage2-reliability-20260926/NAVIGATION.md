# 本轮导航与探索证据实现说明

本文记录阶段 2 离线实现，不构成正式局验收。历史阶段 1 的 111 轮 PASS 及其原始文件保持不变。本轮尚未在本文中声明任何正式运行结果。

## 单一证据来源

`autonomous_brain/road_evidence.py` 的 `RoadEvidence` 持有语义节点、原始观测锚点、出口义务和完整有向行程。`RoadMemory` 的 `nodes`、`exits()`、`summary()`、`unexplored()` 均由该账本派生。旧 `completed` / `blocked` 仅为五态的兼容视图；不再有“位置接近即同节点”或“走到终点即正反出口都完成”的独立记账。

R4 的真实运动路段仍由 `road_segment_records()` 暴露。换位和 `route_to()` 只使用这些实际运动端点；语义节点合并不创建锚点之间的道路捷径。

接口如下：

- `road_evidence()`：`schema = brain-road-evidence/v1`，含 `nodes`、`anchors`、`exits`、`traversals`、`unresolved`。所有 `atNode=true` 的观测都保留，包括空出口列表；冲突索引另留未解决记录。
- 节点状态为 `confirmed / unresolved / alias`。别名保留原身份及 `canonical_id`、全部锚点和合并依据。语义节点数统计 `id == canonical_id` 的节点，包含尚未解决的节点假设，不统计别名和采样路点。
- 出口状态为 `unexplored / exploring / verified / blocked / unresolved`。只有完整实际有向行程可以产生 `verified`。到达处的反向出口仍待处理，直到实际反向行程完成。
- `exploration_status()`：`schema = brain-road-exploration/v1`，包含 `complete`、`pending_exit_count`、五态精确计数及未解决节点/连接计数。`blocked` 仍计入待处理；任一未解决义务阻止未知数量任务完成。

## 身份与恢复依据

原地新鲜观测及核验通过的转向可以延续同一节点身份。相同出口结构的两次平移观测，不能单独区分另一个停车点和相邻路口；无论动作叫 `forward`、`follow_road` 还是 `take_exit`，均保留歧义。`entered_road` 和 15cm 接近条件不能单独消解身份。

已有完整行程支持的路线端点回访，需同时满足规范出发节点、唯一出口、实际连续运动、入向、出口结构、原端点局部范围及里程差与停车偏移一致性。依据记录为 `route_endpoint_revisit` 并引用旧行程。回到同一精确观测位置的闭环保留完整窗口和实际行程引用。自环必须从另一个唯一观测出口返回；沿未完成分支出去后原路掉头，不算完成自环。

抓放期间合法基础运动造成的离路间隙，只能由完整观测和实际基础运动返回原道路锚点消解。返回位置/朝向需符合原 0.2cm / 0.2° 核验容差；每一步有绑定的新鲜相机帧和里程计。此类 `observed_nonroad_return` 只解决该次离路间隙，不生成道路行程或边。未记录的返回保持未解决。历史失败和恢复依据均保留。

完整行程校验保留逐帧窗口、实际原语引用、出发选择、道路连续性、里程、相机帧及 tick 绑定；非零转向不能通过同 tick 的伪造效果证明。旧布尔值、接受命令、路点经过和反向路线候选均不能代替这些条件。

## 离线验证与限制

开发定向回归 127 项通过，日志为外部原始证据目录中的 `raw/navigation/stage2-final-directed-tests.txt`。命令：

```sh
python3 -m pytest -q tests/test_brain_semantic_road_evidence.py tests/test_brain_stage2_adversarial.py tests/test_brain_navigation.py tests/test_brain_reverse_completion.py tests/test_brain_road_node_locator.py tests/test_brain_observed_routes.py tests/test_brain_route_evidence.py tests/test_brain_navigation_reposition.py tests/test_brain_actions.py
```

这些是公开传感输入的合成测试，包含环路、回到起点、不同停车点、近邻相似路口、缺帧、重复帧、回退 tick、受阻恢复和真实反向行程。旧测试中无运动证据的完成期待与按距离合并期待改为保守拒绝；原数值反例保留，没有放宽生产阈值。

R4 完整曲路换位诊断依旧区分“候选生成、候选到达、重新观测、视觉接近通过”；它是合成诊断，不是历史 r102 路线成功或正式局成功。新路线导致状态分叉后，没有继续套用历史模型输出。

无法判别的节点或连接可能使新局 FAIL。实现不会据此删掉待处理区域、改成只探索可达部分，或借助评测地图真值补边。独立评测侧负责核验完整观测引用、合并依据、真实出口覆盖和节点比例；最终联合前置检查及正式结果以本轮主报告为准。
