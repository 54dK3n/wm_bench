# opt-2 第1轮：运行前改动说明

本轮将已通过 opt-1 的单球程序扩展为依次抓取、送达两个目标，并处理抓取空手后的侧向恢复和送货重复路径。**本文件记录待验证实现，不宣称本轮实测通过。** 当前程序 `wm-opt2-r1-20260924`，SHA256 `203e7a8acfa041064f341b6103b1fda4f80cc64b304ca3ae628e34844d79ca0e`；基线 opt1-r2 SHA256 `6cc3479d55051161f2c451226bda3a61a578c8fd9f84d020848c902c2c5d35cc`。身份和片段来源见[构建清单](/Users/ken/Desktop/wm_bench/programs/world_model_opt2.build.json)。

## 目标选择与名义转向成本

从公开 WM 候选、公开有向道路图和实际驶过的里程计道路几何计算 `最短道路距离cm + k×绝对初始转角deg`。距离含起终点所在边的部分长度、单行约束及最近道路投影的并列选项；初始转角是当前航向到目标方位的最短角，不是沿整条路线累计转角。未知道路几何/代价明确记 unknown；唯一记忆目标仍可进入原确认流程，日志不得称其为已证明的最优选择。

`k=0.060290462706043484 cm/°` 来自同一平台原生 `DeterministicSimulator/NavigationActionRunner` 的空直路/路口夹具：固定 speed30、obeySpeedLimit=true，单次 follow100cm×3，take_exit45°/90°/180°各3。12次全部纳入预先冻结的无截距OLS，最大相对残差 **0.4357%**。原始请求、准备动作、逐tick公开里程计、实测距离/角度/耗时和源核心SHA完整保留，未把软件速度公式当测量。[受控标定](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/controlled-calibration/CONTROLLED_CALIBRATION.md)

根任务已通过[USAGE_DECISION](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/constant-evidence/USAGE_DECISION.md)决定将其作为名义P3代价。夹具原报告的“生产授权：否”是当时待决状态，原文不覆盖。**不宣称复杂道路耗时预测达到10%。** 同速真实任务的9个独立场景、全部118条合格 take_exit 均保留外部诊断：该固定名义模型最大残差 **23.5466%（23.55%）**，21条超过10%，没有删样本或重拟合。三个角度条件及其确定性重复不冒充三个真实独立场景。逐条输入索引和原数值见[constant_evidence.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/constant-evidence/constant_evidence.json)。

## 抓取空手后先检查侧向

保留每个原6cm前进站位的首个正向抓取；成功立即返回。空手才在原位最多检查4个额外朝向，仍空手则恢复站位航向，再执行原6cm步进，总前进上限42cm。恢复过程不 observe、不 approach、不平移；继续检查锁定轨迹、公开onRoad、实际航向、持球类别和已知竞争球。

新窗口4.75–16.875cm前向、±4.75cm侧向直接来自公开原生交互范围。角间距 `2×atan(4.75/16.875)=31.4418555716°` 由几何推导。理想执行时覆盖原矩形及“原前向≥4.75cm、半径≤16.875cm”的前方圆帽；不是任意WM误差下的保证。实际角误差、未知竞争目标、超出圆帽及跳过的扫描方向均保留限制。最坏每球40次grab、42cm平移、144次额外导航查询，是有界但有成本的恢复。[几何证明与软件验证](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/grasp-recovery/GRASP_DESIGN.md)

保留原首抓与步进的旧数据依据如下；同B球的重复布局不增加独立数。这些是成功与前向过远证据，**不是三个侧向失败案例**，新增侧向规则的依据是公开窗口几何。

|原始来源|独立真实位置（仅报告）|原向抓取前向序列cm|侧向cm|原结果|
|---|---|---|---:|---|
|stage1 round2 map-01|B|23.4 → 17.4 → 11.4|+1.2|抓到|
|stage1 round2 map-04|C|22.3 → 16.3|+2.4|抓到|
|stage1 round2 map-06|D|17.8 → 11.8|−4.7|抓到|
|stage1 round3 map-09|E|31.1 → 25.1 → 19.1 → 13.1|+3.9|抓到|

源哈希、精确tick及旧事件见[geometry_acceptance.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/grasp-recovery/geometry_acceptance.json)。opt1-r2全部已抓场景的原始数值另在 USAGE_DECISION，未混用不同轮次的局部几何。

## 送货使用公开道路上的有限搜索

旧送货逻辑在节点零位移后继续 follow，或从同一个节点反复进入同一受阻道路。本轮复用阶段1的局部道路限制、视点规划和显式 take_exit，在公开storage道路5cm网格及邻接已测点寻找姿态；每点按既有10°步长有限检查 release_preview。重复路径状态、已尝试停车点、无合法路径均明确结束，不靠反复 observe 探测存放点；送达后必须找到实际离开位移。道路ID仅来自公开图/锚点，下面名称不会成为程序分支。

以下均为 **opt1-r2** 的零基 `raw.lines[L]`：

|布局/原始日志|旧停滞数值与源行|旧退出|
|---|---|---|
|[map-01](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-01.json)|L322/325：release_sample请求80/140cm，实际0、junction；L324/327：return10cm仍0；nw-bag progress36.3，L317净空0.2cm。|L328 未找到存放姿态，仍持目标；查询/控制140/38。|
|[map-04](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-04.json)|L619–622：follow11.3(front_clearance) → node20.7 → exit40.6 → follow11.3；central-north progress22.8→43.5→34.1→22.8，净空0.3cm。|L623 重规划失败，仍持目标；468/177。|
|[map-06](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-06.json)|L758–761同一11.3→20.7→40.6→11.3环，progress22.8/43.5/34.1，净空0.3cm。|L762 重规划失败，仍持目标；411/158。|
|[map-09](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-09.json)|L1232–1235：follow0(front_clearance) → node6.6 → exit37.8(front_clearance) → follow0；central-south progress42.7/49.3，净空0.1cm。|L1236 重规划失败，仍持目标；492/181。|
|[map-10](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-10.json)|L620–623同map-04的11.3→20.7→40.6→11.3环，净空0.3cm。|L624 重规划失败，仍持目标；381/151。|

## 两球编排与动作证据撤销

每球重新建立同轨迹三点确认和最后采样距离凭据；每球 approach≤3 独立计数。observe总数≤92、最后observe位姿、导航查询/控制计数、WM观测及道路几何保持全局，第二球不会获得新的全局预算。第一球失败立即结束；有合格未收集WM候选就选择并确认，无候选则继续巡逻。持球、释放、任务进度分别验证；具体包ID由独立driver验真，运行时holding类别不被冒充为包ID。

新WM提交 `326a5f8892b9da11996b5f3d3d0fc56341aca6e4`（父提交ad237），嵌入ZIP SHA256 `61308c1c20270ec31d8ee5870ed2b01bf6920075e4820e5fc8c30bd2e626f1fb`。`core.py`仅新增 `mark_removed(exact_id, now)` 和模块说明；公开holding确认后立即将原位置轨迹设confidence0/LOST并归档，保留位置、last_seen、命中及帧历史。它是动作证据撤销原位置，不是感知衰减，也不是已送达证明。没有改关联、融合、测距或确认。[提交/包/单测交付](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/wm-kit-action-evidence/HANDOFF.md)

当前改动范围为目标选择、运动与双球编排、动作证据API；M5、过滤器v2全文、WM原融合、确认窗口和间距、最后采样≥0.5m、纯记忆≥30cm、接近≤0.25m/max_steps1均保持。过滤器已污染测试集的声明继续有效，本轮不重写其“独立测试”口径。

正式冻结前以最终[preflight.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/preflight.json)及[tests.txt](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/tests.txt)为准，不在此预填仍可能变化的全量测试数。P3.4、实际双球送达及成功局耗时中位≤300s均待本轮完整批跑，当前不得标PASS。
