# 待修复的道路节点定位一致性回归

当前导航 v3 的定位规则存在可复现的不一致：`RoadMemory.update()` 选择距离最近且小于0.15m的已有节点；`current_node()` 按建立顺序返回第一个小于0.15m的节点，`exits()` 与 `chosen()` 使用后者。本包只准备离线回归及失败基线，尚未修改或验证任何实现修复。

没有修改运行源码、原测试或历史报告，没有启动仿真/API，也没有读取布局、真值或正在运行的 Run15 日志。该问题不构成“未探索义务永久不可清除”的证明，也不被表述为 Run15 失败原因；没有改变15cm、15°、45°门限，没有合并节点或删除任何义务。

## Run14 传感证据

出处为 `artifacts/autonomous-brain/map05-run-14/map-05-run-1/brain/observations.jsonl`，行号即 observation_index；对应摘录保存在 `run14-sensor-excerpts.json`。

| 观测 | 轮次 | rightCm | forwardCm | headingDeg | 作用 |
|---:|---:|---:|---:|---:|---|
| 133 | 22 | -209.3 | 116.8 | -96.9 | 建立junction-9锚点 |
| 145 | 24 | -187.7 | 109.3 | 98.5 | 建立junction-10锚点 |
| 161–163 | 26–27 | -200.1 | 107.7 | -84.3 | 同时距两个锚点小于15cm |
| 164 | 27 | -200.1 | 107.7 | -68.8 | 原地对齐后继续保持重叠近邻 |

161–164的平面位置距junction-9为12.940247cm，距junction-10为12.502800cm。因此 update 选择junction-10，而旧 current_node 选择较早的junction-9。obs163相对出口为144.8°、15.5°、-64.8°；obs164变为129.3°、0°、-80.3°，绝对出口不变。obs164之后的已记录动作是沿相对0°执行take_exit。

`rounds.jsonl` 第27行的输入状态还直接保存了区别：junction-9的绝对-68.8°出口 visits=1、blocked=true；junction-10对应出口 visits=0、blocked=false。给模型的当前出口状态来自junction-9，而当前观测更新规则选择junction-10。摘录不包含模型输出或任何评测真值。

## 独立回归与基线

文件：`proposed_tests/test_brain_road_node_locator.py`。为了不把已知失败混入正式默认测试集，未在 `tests/` 放置同名文件。

夹具用公开位姿及出口值建立两个节点，使用现有 chosen/mark_blocked API 建立可区分的出口状态。两节点在隔离夹具中重新编号，不声称它们是不同或相同的物理路口。第一项另加一个明确标注的合成出口，使update实际写入哪一个节点可直接断言。

11项检查包括：最近节点查询、对应出口状态与选择写入的一致性；等距时维持插入顺序稳定选择；原15cm边界及刚好以内；没有近邻时返回None且不误写其他节点；连续atNode=true但实际25cm跨节点仍保留两个节点并只闭合已走出口。

实际命令（工作目录为仓库根目录）：

```text
python3 -B -m pytest -q -p no:cacheprovider artifacts/autonomous-brain/road-node-locator-review-20260926/proposed_tests/test_brain_road_node_locator.py
```

输出：`3 failed, 8 passed in 0.06s`，exit code 1。三项失败分别定位current_node、exits、chosen的不一致；这三项是同一个问题的三个可见后果。完整输出见 `baseline-tests-v1.txt`，精确命令和前后源码哈希见 `baseline-validation-v1.json`。没有运行或声称候选实现通过。

- 导航版本：`autonomous-brain-navigation/v3`。
- 导航源码SHA256：`a7f26802bbb847137bddac74a8cb6d1c9dc645d82a61fb13dab18f1ed7ab9cf1`。
- 新测试SHA256：`fac263813b5492e500e444e4e2de1e0cc3b19ce7faa61224a05478185d1a96c9`。
- 基线Git HEAD：`a69eb9007b1fb9893e64471c30170067acc4c86f`。
- autonomous_brain内全部Python源码测试前后哈希相同。导航源码快照为 `navigation-v3-source.py.txt`。

预期未来修复范围仅是统一update/current_node/exits/chosen的既有近邻定位规则，并保留原边界、稳定等距规则和跨节点完成语义。实施与修复后的回归仍待正式运行结束后另行授权；本包到此暂停。
