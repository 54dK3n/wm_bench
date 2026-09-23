# P3.1 最小公开 API 标定协议（未执行）

冻结后使用请求 speed=30、obeySpeedLimit=True。测量批次为独立的12个完整控制：follow_road(100)三次；take_exit 的公开请求出口角45/90/180°各三次。全部准备移动和失败尝试也进入完整record.inputs，不能作为未登记试跑。采集轮次/预算归属先由根任务明确。

1. 只用公开 map_graph、road_state、odometry 判断合法道路、单行限制、剩余长度和净空。选足够长的道路，在道路内稳定起步；单次调用follow_road(100,30,True)。记录精确起止odometry和返回elapsedTicks/distanceCm/stoppedBy。需accepted=True、max_distance结束及实际完整100cm；遇节点/净空提前停止必须保留为不合格实验，不能用十段10cm替代。
2. 在合法节点选择公开exits中的出口，以该项turnDeg减所需45/90/180°得到准备朝向旋转量。准备旋转后重新读取road_state确认出口仍合法和其公开转角；准备转向本身不当作take_exit标定。完整记录旋转和重定位，不读取目标锚点或真值坐标。
3. 在测量动作前写明phase=measurement、组角、repeat编号、speed/obey；随后调用take_exit。起止都读取公开odometry；要求accepted=True且stoppedBy=entered_road。拟合用实际distanceCm与实际最短heading差，同时另列请求出口角；不能把名义180°直接填成实测180°。每组全部三个重复均列出。
4. 重复间所有返回节点/道路与调整朝向均标记phase=preparation并留档；不得因看到残差再把某次measurement改成preparation。规定测量资格只看控制、速度、stopreason、精确公开里程计；失败尝试保留原因。新采集结束前不改程序。
5. 按预定模型elapsedTicks=a*distance_cm+b*abs(turn_deg)一次拟合全部合格测量，k=b/a。逐条相对残差=abs(predicted-observed)/observed，门限10%；不按残差排除。若仍不满足，明确单k模型/适用域受阻，不能引用软件内速度常数充作实测，也不自动增加隐藏轮次。

本文件是采集方案，不含可执行生产程序；本次没有发出任何机器人命令。
