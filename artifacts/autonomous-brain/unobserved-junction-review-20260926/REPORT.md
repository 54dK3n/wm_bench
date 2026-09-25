Run19 未观测到路口却返回成功：只读诊断

结论：冻结 Actions v18 在三次真实公共传感输入上，把执行器的 `stoppedBy=junction` 当成了“已观察到下一路口”。三次调用没有位移、没有消耗仿真 tick，后观测也没有节点或出口，却返回 `success=true / next_junction_observed`。这是动作后验判断的确定缺陷。本目录没有应用修复、修改运行源码或默认测试集，也没有运行仿真、真实模型或恢复动作；不能充当本局完成或恢复成功的证据。

仅选取 Run19 已完成 r140、r145、r146 的公共脑日志。没有读取评测真值、布局、隐藏 record、凭据或后续轮。原日志未修改。输入摘录见 [public-excerpts.json](public-excerpts.json)，包括三个动作结果、六个完整公共观察和三条 motion。

| 轮次 | 观察对 | 仿真时间／tick（前后相同） | 执行器结果 | 动作结果 |
| --- | --- | --- | --- | --- |
| 140 | 925→926 | 668.46 s／33423 | accepted=true, junction, 0 cm, 0 ticks | success=true, next_junction_observed |
| 145 | 952→953 | 677.74 s／33887 | 同上 | 同上 |
| 146 | 955→956 | 677.74 s／33887 | 同上 | 同上 |

六帧都为：里程计 `(rightCm=103.3, forwardCm=31.9, headingDeg=-171, distanceCm=4258.2)`；道路 `onRoad=true, lateralOffsetCm=-9.1, headingErrorDeg=-47.6, leftClearanceCm=0.1, rightClearanceCm=18.3, frontClearanceCm=28.4, atNode=false, atJunction=false, exits=[]`；夹爪仍持物。每次请求为 `follow_road(distanceCm=20,speed=50)`。三个观察对的完整 road、odometry 和 simulation_seconds 逐值相同。

执行器和观测的判据不同，源码定位保存在 [source-excerpts.txt](source-excerpts.txt)：

- `competition-core.js:3843–3854`：沿中心线投影进度计算到路口接近边界的 available；available≤EPSILON 便直接返回 junction，不进入转向／居中的 runPath。
- `competition-core.js:807–825`：公开 atNode 按车体实际位置到节点的欧氏距离是否在原 radius 内判断。`robot-backend-runtime.js:55–61` 原样传出该结果，不添加节点推断。
- 对有侧偏的车，纵向投影到边界并不保证车体已在节点圆内。例如直线末段，若纵向剩余为 R、侧偏非零 y，则实际距离为 `sqrt(R²+y²)>R`。这里的 −9.1 cm 是实际公开侧偏；没有用布局反算节点位置或声称真实差距是多少。
- `actions.py:417–418` 使用 `fresh.atNode OR stoppedBy==junction`，先于 419–421 的实际位移检查，造成三次假成功。395–397 的 take_exit 分支也有同类 raw-junction 替代观测判断；330–333 的恢复分支虽返回失败，却可能虚称已返回路口。
- `navigation.py:77–108` 仍要求真实 atNode 且有 exits 才记账到达，所以三次假成功本身不会把出口标 completed。这是执行反馈和传感后验不一致，不能用增大 radius 或修改记忆合并阈值消除。

最小离线基线使用复制的冻结 `actions.py/navigation.py/bridge.py/__init__.py`，假桥只回放每次已保存的公共执行器结果，observe 只切换到对应已保存的后帧。调用的是未修改的 Actions.explore/Actions.move 和 RoadMemory，不替换成功分支；复现结果与原动作逐字段一致，仅排除由外层 runtime 增加的 before_observation/final_observation 两项。产生的 motion 与原 motion 完全一致。网络和机器人调用均为零。

从仓库根目录执行：

```text
python3 -B artifacts/autonomous-brain/unobserved-junction-review-20260926/reproduce_baseline.py
```

结果为 **2 passed、3 failed，exit 1**。失败是三个独立的“未观测到节点不能成功”断言；通过的是“三组输入确实没有位移／节点”和“现有道路净空预算禁止当前航向直接前进”。这不是修复通过结果。完整输出见 [baseline-v1.stdout.txt](baseline-v1.stdout.txt)，命令与退出码见 [baseline-v1.execution.json](baseline-v1.execution.json)。stderr 为空。

候选修复尚未实现或验证：

1. 到达结论必须依赖动作后的 fresh onRoad／atNode 证据，保存 fresh exits 和实测位移；单独记录 `junction_stop_not_observed` 这种不一致，不把执行器标签当成后验。
2. 不能简单去掉 OR 后落入现有 return_from_blocked_road：该函数 310–313 会无条件标 blocked 并清除 active_exit，错误地把判据不一致当成道路障碍。对此情况应保持 completed／blocked 不变。
3. 有限恢复只用公开 road／odometry：先按当前 headingError 对准局部切线，再 fresh 观察；仅在有限有效道路几何、前方净空和原道路平移预算允许时，执行有明确步数／总距离上限的短步，每步复核实测里程计及 onRoad。持续矛盾、无进展、离路或无安全余量即停止失败。恢复的具体预算及是否有效仍需离线回归与独立诊断验证，不能宣称已能救回本局。
4. 当前姿态直接前探不合法：road_translation_limit 的侧向约束取左侧，`max(0,0.1−0.1)=0`，故任何正请求的 forward 许可都为零。若选择返回已观测道路，应先面向公开反向切线并重测前方净空，不能靠没有后方传感器的 blind backward。不得扩大 radius、道路安全门槛、15 cm 节点规则或提前关闭探索义务。

源码与输入证据：

- 冻结 Run19 提交为 `609772040d00f35e3ec6e25cfa5433894be4e5a7`。四个脑源码文件均与该提交逐字节相同；当前 HEAD 可因独立归档提交前进，不代表运行源码改变。
- Actions v18 SHA256：`491475b39aea9961b492dcc94709b088a5adf32296452a587ed2744892038134`；Navigation v4：`3238323babe95ac32cf45e6ce833ecba32857dd31a247b78ee5495ba768a7981`。
- 三个外部平台文件不属于根 Git 树，只记录当前源码哈希，不伪称与根提交逐字相同。全部七文件在本次复现前后哈希一致：[source-before.json](source-before.json)、[source-after.json](source-after.json)。首次采集曾错误假设平台文件在根 Git 树，因 git show 找不到文件而退出，尚未生成摘录；修正来源标记后完成采集。
- 活日志只哈希稳定的已完成字节前缀，不声称冻结全文件：[input-prefix-sha256.json](input-prefix-sha256.json)。rounds 前146行／9,857,682 bytes；observations 前956行／58,496,213 bytes；motions 前665行／113,308 bytes（截至 after_observation=956）。原始前缀未复制；只保存所需摘录。
- 复现后再次按固定字节数校验，三个前缀均相同：[prefix-recheck.json](prefix-recheck.json)。其后追加内容既未读取用于分析，也未计入这些哈希。
- 本目录各产物 SHA256 见 [SHA256SUMS.json](SHA256SUMS.json)。仅新增此诊断目录，未提交。
