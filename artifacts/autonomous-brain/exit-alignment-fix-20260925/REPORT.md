# 出口先对准、再观测选择与受阻判定修复

第十局在首球观测放置并归路后，探索重复执行同一出口却没有位移。r43 原生结果是 front_clearance、8.7 cm、70 ticks，旧代码因仍处于 atNode 范围而先返回 next_junction_observed；r44 等七次调用更是 front_clearance、0 cm、0 ticks。原始传感器扫描显示反向道路有净空，不能把这些调用解释为所有方向都被堵。见[传感器复现](REPRODUCTION.md)和[本局失败分析](../map05-run-10/FAILURE_ANALYSIS.md)。

Actions v13 对 explore/go_to 统一使用以下流程：由当前相对出口角和里程计计算所选朝向，原地转向，取得新观测，再使用实际转后航向重新计算相对角；只有新鲜 onRoad/atNode 仍成立、同一朝向在新出口列表中按原 5°规则唯一匹配，才调用 take_exit。出口消失或歧义立即失败，不复用旧角，也不假定转向完全精确。道路 ID、进度和平台布局不进入大脑。

explore 对 front_clearance、collision、off_road、wrong_way 的阻挡结果先处理，再判断是否到达路口。原始执行器结果保留在失败证据里；不再由 atNode 覆盖受阻短移。

同份 17 项回归在冻结 v12 为 14 failed / 3 passed，导航改动为 17 passed。测试包括实际转向残差 2°后的新角选择、出口消失/多个候选/角度不符、转向后离路或失去路口、8.7 cm受阻短移与零位移，以及真实6.4 cm到达路口的成功对照；见 baseline-tests.*、current-navigation-tests.*。另有 40 项已有动作/路线测试通过。已有路线 fixture 现按车头转动同步旋转相对出口，并用绝对出口朝向校验原路线选择，未删除路径顺序断言。

这里的 current-navigation-tests 只证明导航候选版本，其源 SHA 在对应 JSON。与独立历史假设分类修复合并后的最终版本、完整测试和 SHA 见 INTEGRATION.md / integrated-tests.json / version.json。离线通过不代表 map-05 双球任务通过；下一次运行使用新目录。
