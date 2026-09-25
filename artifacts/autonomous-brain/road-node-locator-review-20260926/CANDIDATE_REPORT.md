# 独立候选副本验证

本目录的 `candidate/navigation.py` 为 `autonomous-brain-navigation/v4-candidate`，未应用到生产包，也未接入正在运行的 Run15。源码只改变定位规则的复用和候选版本号：update调用current_node；current_node按最近距离定位，仅接受严格小于0.15m的节点。Python min在等距时保留首次出现项，因此仍按插入顺序稳定处理完全等距。节点创建、角度门限、实际穿行闭合和其余导航规则不变。

候选SHA256：`cc9b9689ed422125835a9e339a81ea5217094045b7f7bb714b3408009f059041`。生产navigation.py仍为v3，SHA256仍是 `a7f26802bbb847137bddac74a8cb6d1c9dc645d82a61fb13dab18f1ed7ab9cf1`，与原失败基线保存的源码快照逐字节相同。审阅差异另存 `candidate-navigation-v4.diff`；它未被应用。

仅将测试进程中的 `autonomous_brain.navigation` 模块导入替换为该候选副本，显式运行：

- `proposed_tests/test_brain_road_node_locator.py`：原11项回归未修改，原v3是3失败/8通过。
- `proposed_tests/test_run14_sensor_locator.py`：新增1项，从原Run14的brain observations/rounds/motions读取指定传感值及已经发送给模型的节点历史，不读取平台布局、真值或live Run15数据。

候选结果为12项通过、exit code 0。精确命令、原始stdout及源码前后SHA分别见 `candidate-validation-v1.json`、`candidate-tests-v1.txt`。该次运行未扩展到全套测试，没有网络请求或额外仿真。

原始传感复现使用Run14 r27输入内的节点历史及obs161–164。车位(-200.1,107.7cm)距junction-9为12.940247cm，距junction-10为12.502800cm。四帧update后的current_node均为junction-10，读取的-68.8°出口均为visits0、未blocked、未completed；按原obs164后记录的take_exit相对0°调用chosen后，仅junction-10对应出口visits变为1。junction-9逐字段不变，节点数与未探索义务数量也不变。这里只重放传感数据与本地记忆操作，没有执行该运动。

验证时生产autonomous_brain内全部Python源码前后哈希相同，默认tests内测试文件集合与内容摘要前后相同；`tests/test_brain_road_node_locator.py`不存在。候选和两个回归仍只在本证据目录中。

这是已通过所列定向检查的候选实现，不是正式运行通过证明，不证明Run14导航永久死锁，也不解释或预判Run15成败。是否应用应在当前正式运行完整导出后按实际结果另行决定；没有提交或修改历史报告。
