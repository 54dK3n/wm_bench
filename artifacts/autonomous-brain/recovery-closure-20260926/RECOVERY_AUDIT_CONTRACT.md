# 恢复闭环的独立复核合同

本文件说明本轮开发联通证据；它不代表正式仿真、模型运行或验收通过。原有报告、原始记录与原判定未改写。评测器版本为 `autonomous-brain-offline-evaluation/v8`，保留 driver v7/v8 历史来源规则，并要求新 driver v9 同样提供三个独立 helper 的实际源码哈希及 `road_evidence.py` 哈希。

## 延迟抓持身份确认

真实 `Actions.pick` 在实际 grab 命令后记录 `brain-grasp-chain/v1`。`grab` 保存实际命令的 request ID、完整桥日志序号、before/after observation、原 object ID/类别/位置和原空夹爪状态。Runtime 每次观测追加完整持物链；任何未知/空夹爪、缺帧、重复帧或逆序都保持 pending。

`place` 可用后继新帧确认原位置已空，随后产生 pick 身份事件；该事件的实际 grab 仍指向原 pick 决策轮次，confirmation 指向当前 place 决策轮次。动作回执保留相同 `grasp_confirmation`。确认后再取得新观测，确保 release 前的对象快照已记录 HELD。

独立审计从原桥命令、原始观测、动作轮次、motions 复算这两个窗口，重投影原位置并检查遮挡/仍有物体，检查从实际 grab 后到确认再到 release 前的每帧 holding。release 保存自己的 `command_ref`，并反指同一 grab request ID。一个实际 grab 只能支持一个身份事件；重复事件的逐项 `verified` 为 false。

unknown 命令回执只有保留实际提交接收凭据、原命令引用、fresh false→true 持物变化及全部后继身份条件时才可恢复。没有接收凭据、掉球后恢复持物、假 place、旧确认帧或错身份均拒绝，不重发 grab。

机器证据：`raw/evaluation/p5-real-actions-independent-audit.json`（同动作正对照与跨动作延迟确认的完整合成传感/桥/动作链）；负例见 `tests/test_brain_pending_grasp_audit.py`。

## 发现账与撤销

`brain-discovery-evidence/v2` 的每个原红框均从 raw observation、转换结果和原里程计独立重建；普通未入库、近场、远场和竞争观测都不能因后继空帧消失。resolver 必须提供原像素兼容、至少两个分离视角、原三视角确认和同帧双向唯一竞争矩阵，且保留所有竞争者及其排除依据。

原始 bbox 宽度用于重投影约束；饱和的 100 cm 读数不能充当精确锚点。任意实际 grab/release 均隔断静态关联，包括桥中存在而 brain motion/boundary 账被删除的命令、未知执行窗口以及延迟确认时回指的实际 grab。

退休未确认身份只有其全部原 source 已有独立有效、指向同一 successor 的 resolution 才能折叠；折叠本身不证明 delivery。每帧有效 resolution 重新复核，不能靠缓存沿用已撤销证明。撤销必须保留原 proof 和操纵边界，重新出现的 unresolved 会阻止未知数量任务完成。

`raw/evaluation/discovery-lifecycle-examples-audit.json` 对 12 个合成生命周期入口进行独立复核：7 个合法发现解释入口通过；5 个未解决入口保留 pending。后者包括已知两球任务中的额外发现对照：此文件主动调用 unknown 发现子审计，所以列出 pending；正式 known-two 的 task scope 不启用全图未知数量义务。该文件不是 `evaluate_run` 通过声明，也不是全局真实物体身份/交付 Judge 的替代。

## 道路身份与归路

`observed_anchor_return` 仅证明公开完整 basic-motion 窗口返回原精确锚点；1 cm 疑点节点继续保留，不能增加已探索出口。

`retrospective_route_identity_resolution` 必须具有独立已完成旧路线及本次新完整路线、精确相同的旧疑点锚点、完整 motion refs，以及迁移前 nodes/anchors/exits/traversals。审计同时核验原出口的一一映射、全部原观测义务、旧完整 traversal ID/窗口/行程和 completion 引用均保留；遗漏旧 trip、丢 completion 引用或伪造映射会失败。

真实归路 `6→-1→0` 的首次 onRoad 与最终 map reconnect 分开：只在完整原入口返回证明后解除 connection。该证明不删除其他节点疑点、不补已探索路线。原有全图分母、缺节点、false merge、unresolved、ratio 和每条合法有向出口完整 traversal 门均保持。

联通测试：`tests/test_brain_recovery_topology_audit.py`，机器入口：`raw/navigation/independent-topology-linked-diagnostics.json`。所有 native 图/精确 capture pose 只用于评测，不传给脑。

## 本轮定向结果

13 个相关测试文件合计 **267 passed**。精确命令与输出在 `raw/evaluation/consumer-directed-final.txt`；退出码、统计、日志 SHA256 在 `raw/evaluation/consumer-directed-final.json`；消费端源码哈希在 `raw/evaluation/consumer-source-sha256.json`。这是开发定向回归，等待根任务的全体联合门。
