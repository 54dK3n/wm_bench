# 阶段 2 独立评测定义（正式运行前冻结）

本定义与实现只用于离线验收。开发验证为固定合成记录与已恢复证据的只读诊断，没有新仿真或模型调用；不改写阶段 1 原评测、原 Judge、前缀审计或历史证据。

任务固定为“把地图上的红球都送到绿色存放区”。已知两个红球的阶段 1 不要求全图探索。十布局及真机入口仍关闭。

## 范围与通过条件

- 分母 D：原 `record.native.ruleDefinition.roads` 的全部首尾端点，按冻结平台 JS `Math.round(value * 1e6) / 1e6` 分组，包括 1、2、3+ 度节点和没有合法出边的单行终点；曲路内部采样点不计。取完整地图，不按本次可达或已见范围裁剪。
- 分子 N：`summary.road_evidence.nodes` 全部语义身份，包含未解决假设。只有原始锚点与实际连续运动支持、独立核验通过的 alias 可排除。普通行驶轨迹点不作为语义节点。不能删除未解决节点来降低比例。
- 必须 N / D ≤ 1.2，同时缺失真实节点、错误合并、未解决身份及连接均为零，每条合法有向道路出口均有实际完整行程。重复脑节点按所绑定真实节点单列，额外身份计入 N；不另行偷加“重复必须零”的门槛。
- 受阻、正在探索、未探索、未解决均为待处理。历史已完成行程可保留，但后来受阻的当前出口仍不能完成任务。反向出口存在只证明可以尝试；须另有反向实际完整行程才算覆盖。
- 所有已发现目标交付、全图所有真实目标最终交付、夹爪空、大脑身份去重、模型真实原始 `done` 字节和后续完成观测沿用 R2 门禁。拓扑合格不代替抓放/完成验收。

## 原始输入与独立对应

`tools/brain_topology_audit.py` 不调用 RoadMemory 的建图/完成方法。输入为 `brain/summary.json`、`brain/observations.jsonl`、`brain/motions.jsonl`、`brain/bridge-calls.jsonl`、`record.json[.gz]`、`captures.json[.gz]`。`evaluate_task_scope` 自行调用审计，不能用传入的完成布尔或预先写好的审计报告替换。

每个观测序号、相机帧、锚点、运动窗口和声明身份必须唯一；序号连续。桥接器中相同原帧的 observe / odometry / local_road / holding 必须与快照一致，动作请求、参数和实际回复须位于相邻观测间的正确窗口。缺失、冲突或不支持的合同明确 FAIL。

评测侧以唯一 `frameId` 且相同 tick 的 `captures[].robotWorldPose` 完整精度坐标复算道路选择、节点投影、出口方向；同一 capture 的 `odometryOrigin` 与尺度复算公开里程计。原 record 样本允许稀疏，不要求每个相机 tick 都有样本；已有同 tick 样本须与 capture 按原坐标六位/角度四位记录精度一致。重复 capture、冲突 tick/pose/origin 均拒绝。没有为了跨越节点半径边界而扩大容差。

真实图及关联只存在评测侧。匹配重现冻结平台 v6：道路先按朝向误差、中心线距离、道路 ID 选择；节点限于该道路端点，按原半径、前方优先、距离、平台 `node:<encoded road ID>:<start/end>` 字典序选取。不是把锚点强行关联到全图最近节点。出口角度只容许公开 0.1 度量化误差。同一 canonical 身份跨越两个真实节点即错误合并。

完整行程须从新鲜原出口选择开始，覆盖全部观测与运动引用，沿所选道路到达另一端；不能跳过中间已到达的不同节点。检查实际里程、位移、tick、方向、转角、夹持连续性、onRoad 与执行停止原因；basic forward/backward/turn 按原 0.2 cm / 0.2 度核对动作效果。原生路径中间样本离开该道路也会拒绝，不能只靠两个好端点。record 坐标量化的不确定度仅用于其辅助走廊核验，不能扩大原 capture 的端点投影边界。

alias 分别核验连续同节点观测、完整路线回访、已有路线端点的不同停车位置回访、实际非道路抓放往返。每次保留原临时身份与合并引用；回访须完整实际运动、结构及方向支持。非道路往返只恢复原锚点身份，不增加道路边。已解决历史问题必须引用已核验行程或已核验非道路返回窗口，不能把 `resolved:true` 当证明。平台原合同拒绝单条道路首尾 snap 后相同的自环；此类输入明确不支持，真实多道路环路正常复核。

独立复算探索字典采用 `brain-road-exploration/v1`，五态精确为 unexplored / exploring / verified / blocked / unresolved。它与 summary 对照后传入未知数量完成门禁，不信任 summary 的 complete。

## 历史发现、模型与抓放

`tools/brain_evidence_audit.py:audit_unknown_discoveries` 按所有原帧检测下标与转换证据重建未入 WM 的红球歧义。键为 `(frame_id, detection_index)`，原框、候选、歧义理由、轮次、tick 和观测序号须保留；逐帧累积账及最终 `brain-discovery-evidence/v1` 均须一致。本版没有通用合法 resolver，后续空视野、候选 DELIVERED 标签或删账都不能消除历史发现。

全动作前缀审计与全局 Judge 分别输出；历史 unverifiable 不自动变成 fail 或 match。完成证据另做原几何、释放边界、唯一候选、旧球排除和真实物体去重，模型日志执行严格离线重放。阶段 1 历史 v7 的源码证明规则保留；新 driver v8 额外冻结三个评测依赖 `brain_evidence_audit.py`、`replay_brain_llm.py`、`brain_topology_audit.py`，并要求记录脑端 `road_evidence.py`。

## 定向验证入口

运行：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q \
  tests/test_brain_topology_evaluation.py \
  tests/test_brain_unknown_discovery_evaluation.py \
  tests/test_brain_evidence_reliability.py \
  tests/test_brain_stage1_evaluation.py tests/test_brain_evaluation.py \
  tests/test_brain_evaluator_dependencies.py tests/test_brain_stage1_source_proof.py
```

合成覆盖包括：真实 RoadMemory 到独立评测的完整往返、三道路环路、同节点不同停车位置回访、非道路返回只恢复身份、单行无出边终点、缺帧、缺运动引用、受阻、仅 accepted、错误转角/位移、虚假反向完成、近邻不同节点、错误合并、遗漏完整地图、伪 alias、报告计数篡改、稀疏 samples 与精确 capture、冲突 capture，以及空帧不可消除历史红框歧义。这些是开发测试，不是正式局探索成功。

本轮定向开发回归：上述命令共 200 项通过（其中 topology 47 项、历史发现独立重建 6 项）；等待根任务最终联合离线验收，尚未开始正式阶段 1/2 运行。
