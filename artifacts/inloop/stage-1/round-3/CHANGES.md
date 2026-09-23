# 阶段 1 第 3 轮变更与运行前依据

第 2 轮十局完成后，先生成 batch_report.json / stage_report.json：程序错误 0/10、重复 observe 0，但独立场景确认并抓到 7/9=77.8%，判 FAIL。freeze_verification.json 的 13 项均 true，然后才修改本轮代码。这是阶段 1 最后一次批跑机会；若仍失败即停止，不进入阶段 2–5。

## 修正范围

- 中途道路受阻时记录实际路段及方向并重新计算替代路径，不把尚未抵达的目标停车点或目标道路入口永久删除。重复操作的判定包含路由与阻塞状态，允许同位姿上的新替代路线。
- 控制返回 max_distance 且道路进度确有变化时，重新读取进度继续规划；无进展仍失败。保持候选 5cm 网格与实际采样约束，不新增抵达容差。
- 最后一段进入邻路的成本纳入 take_exit 正常自动进入 25cm 的行为；双向道路含必要折返，单向道路排除不可回达的入口前停车点。未知道路探索可先抵达 API 入口落点，再测量几何。入路后仍按实际 road_state 重算。
- 未知区间的探索顺序加入到 WM 细接近区域的欧氏距离下界。已知有效停车点仍按道路 Dijkstra 距离选最短。未知坐标不外推、不查真值。

## 数值依据与常数来源

可复跑来源：第 2 轮 map JSON 的 lines；python3 tools/extract_round_diagnostics.py artifacts/inloop/stage-1/round-2。详细输出以该脚本最终字段为准。

| 独立场景 | 记忆图接近行驶 cm | max_distance 后被永久拒绝次数 | 过渡路 front_clearance 拒绝次数 |
|---|---:|---:|---:|
| map-02 | 1311.9 | 3 | 0 |
| map-05 | 2727.8 | 5 | 6 |
| map-08 | 1944.5 | 5 | 8 |
| map-09 | 3291.8 | 5 | 9 |

上述四局在既定轨迹合并口径下各为独立场景。修正回应共同的路由/残差问题，没有为某布局设分支。map-09 的两个目标道路入口都因同一上游受阻路径失败而被删除；最后 WM 距离 0.653m，大于原细接近门槛 0.30m，queries831/1000、controls294/300，没有耗尽配额。

- 新使用的 25cm 不是拟合阈值：它等于平台 navigation controller 的 exitEntryCm。来源 competition-core.js:117、3896–3910；API 无距离参数可覆盖该值。第 2 轮 viewpoint_take_exit 的 actualProgressCm=25 运行证据：map-02/05/08/09 分别 12/28/23/27 条，逐行索引保存在 numeric_diagnostics.json 的 api_entry_progress_25cm；返回 distanceCm 同时包含旧路和节点连接段，不能当作新路进度。
- 探索剩余距离为 max(0,欧氏距离−既有0.30m细接近半径)，再按单位换成 cm；系数1由距离下界推导，无拟合权重。没有坐标的端点只按三角不等式、已测点和公开道路长度传播距离下界，不生成其空间坐标。
- 用户要求的45–85cm预测窗、40–90cm命中窗、3次同轨迹命中、全部位姿间隔≥15cm、末点≥0.5m、≥5cm或≥10°才observe、纯记忆≥30cm、approach≤0.25m且max_steps=1保持不变。
- 第 2 轮 map-07 仍为伪红单命中；本轮不把它当真球、不据此调整模型或提前进行阶段2过滤器测试。赛题1仍未运行。

PROGRAM_VERSION：wm-stage1-r3-20260923。wm_kit 与 M5 模型未修改，嵌入包仍对应 ad237a143f0d35e100a28c15567d4b75bd56cccf。

## 最终运行前检查

123项回归通过，无skip/xfail；指定pylint五类错误0；实际平台AsyncRobotTransformer转换后完整程序编译通过；get_truth词元0；坐标静态检查无成对违规。14个嵌入包文件逐字节等于已提交wm_kit。独立复核发现并修复折返方向、端点出口、成功路径重访三项边界，报告见review.json。

完整差异见changes.patch；文件清单与SHA256见code_manifest.json。
