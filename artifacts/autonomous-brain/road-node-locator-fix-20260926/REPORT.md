# 道路节点定位一致性修复

正式版本为 `autonomous-brain-navigation/v4`。当多个已记录节点都落在车位15cm以内时，观测更新、当前出口状态与出口选择现在使用同一个最近节点。完全等距时保持插入顺序稳定；距离条件仍是严格小于0.15m，节点创建、15°出口对应、45°逆向证据和其余既有规则未改。

仅修改生产文件 `autonomous_brain/navigation.py`。正式代码与已定向验证的独立候选逐字一致，区别仅为版本号由v4-candidate改为v4。原11项独立回归复制到 `tests/test_brain_road_node_locator.py`，仅更新文件说明，所有行为断言保持不变。未修改其他生产文件、CURRENT_REPORT或其他文档，未提交。

本次修复在Run15完整退出、源码前后核对通过之后应用，没有改变该局运行输入或历史结果。它修复的是同一观测查询与选择所用记忆索引不一致，不构成Run14永久导航死锁的证明，也不把Run15终止归因于本问题。

此前证据保持原样：

- `artifacts/autonomous-brain/road-node-locator-review-20260926/BASELINE_REPORT.md`：导航v3的11项回归为3失败、8通过；包含Run14原传感出处。
- `artifacts/autonomous-brain/road-node-locator-review-20260926/CANDIDATE_REPORT.md`：隔离候选的原11项和额外原始Run14传感复现共12项通过；候选未接入当时的正式试验。

本次用rg识别导航/道路相关测试后，运行新locator、navigation、reverse_completion、exit_alignment、route_progress、actions_navigation_regression、road_clearance、pick_road_return八个测试文件。结果：`88 passed in 0.06s`，exit code 0。完整stdout在 [navigation-road-tests-v1.txt](navigation-road-tests-v1.txt)；实际命令、测试文件SHA与所有生产Python源码测试前后SHA在 [navigation-road-validation-v1.json](navigation-road-validation-v1.json)。

root独立完成整套brain回归：`567 passed in 0.61s`，exit code 0，源码before/after相同。完整stdout和验证记录分别为 [integrated-tests-v1.txt](integrated-tests-v1.txt) 与 [integrated-tests-v1.json](integrated-tests-v1.json)。未重复运行这套测试。

正式navigation.py SHA256：`3238323babe95ac32cf45e6ce833ecba32857dd31a247b78ee5495ba768a7981`。

新测试SHA256：`9a05bbdf1ea0c1aa94c9154b613b1952461add5a84289a3bfc6e07a1e77afab1`。

修改前navigation.py SHA256：`a7f26802bbb847137bddac74a8cb6d1c9dc645d82a61fb13dab18f1ed7ab9cf1`。所有生产文件的修改前快照哈希在 `before-implementation.json`。对比生产源码，唯一变化为navigation.py；定向测试前后全部生产源码哈希相同。

这是一项已通过所列离线回归的实现修复，不是新的物理运行成功声明。未启动额外仿真、模型请求，也未读取布局或评测真值。
