# 普通发现与对象恢复闭环

问题 1 在进入本轮工作区时仍存在：普通近场 25cm、远场 95cm、原适配器截断后的 140cm 红框未入 WM 且无身份冲突时，发现账为空，未知数量完成门可错误放行。问题 2 的发现 resolver 当时缺失；已有同帧分离的释放恢复能够确认交付，但不会解释历史发现。首次独立复现 **7 failed / 0 passed**，为代码反例，不是环境失败；见 `raw/discovery/first-red.txt`。本轮允许正常开发迭代，未把已知红测试当正式停止门。

## 修改与证据规则

- `autonomous_brain/perception.py` 升为 v11；`brain-discovery-evidence/v2` 保留每个原始红框的不可变 records（frame/index、原 bbox、odometry、身份候选、原关联和理由），另外保存 associations、resolutions、操纵窗口及撤销证明。未关联红框、歧义框、尚未解释的退休假设都会保留义务。WM 原 40–90cm 窗口、三独立视角和竞争门未改。
- 重复观测仅在两个方向都唯一、原像素几何兼容且不跨操纵时归入同一 hypothesis。重复 camera frame 仍被拒绝；同帧两个红框保留两条来源，不合成一个物理目标。
- 最小 resolver 要求候选身份已有原 WM 三视角确认，且发现之后至少两个相隔原 0.15m 的新视角。逆 M5 将各支持位置投回原始 bbox；容差只对应 bbox 整像素、原距离/角度舍入，不使用放大的 WM 距离门。远场直接核对原宽度，不把截断的 100cm 当精确位置。全原帧红框建立双向唯一矩阵；只有一个后继观测的竞争者也仍在矩阵中。
- 原 identity_ambiguity 的其他身份必须在两个支持帧中同帧被独立观察，并有反投影排除证据。空帧、时间、候选全已 DELIVERED、仅位置近邻都不能清账。真实 grab/release（含未确定执行的 intent）阻断跨操纵静态证明；迟到的实际抓取边界会撤销旧 proof，并保留撤销原因及原证明。
- 原退休对象的全部来源获得一致后继证明后才折叠任务关联；不复活或删除旧 LOST 行。发现被解释仅表示已关联到规范对象，**不表示已经交付**。`task.py` 仍须该对象拥有有效独立交付证据才解除任务义务。
- `task.py` 增加当前普通未解释红框的独立拒绝门，陈旧空发现账也不能掩盖当前框；保留未知数量历史义务。已知数量分支仍依据两个不同合法交付及夹爪/相关身份条件，不强加全图探索或无关历史发现。`run.py::Runtime.state` 仅新增最多 6 条的发现摘要，候选 ID 有界；发现 ID 不成为可抓取对象。
- `Runtime.observe` 与 `Actions.move` 的操纵窗口接入由审计子任务协同完成；本子任务只改 Runtime.state，未改模型调用或导航实现。

## 验证范围

新 `tests/test_brain_recovery_discovery.py`：**24 passed**。18 个相关文件：**362 passed / 0 failed / 0 skipped**，包括真实感知、抓放、释放恢复、任务与状态，以及独立发现审计。定向集合属于相关集合的子集，不能相加。完整命令在 `raw/discovery/directed-final.txt`、`raw/discovery/related-final.txt` 和 `raw/discovery/implementation-summary.json`。另向 `tests/test_brain_discovery_lifecycle_audit.py` 添加 4 个真实来源正例：退休重获交付、旧交付遮挡重现、新释放靠旧球以及普通发现与退休来源的后继折叠；独立消费者由审计子任务实现，未复用脑端 resolver。

正反对照覆盖：普通近/远/截断远场；同对象重复观测与重复帧；同帧两框不能共用一个身份，以及两对象各自合法确认；已有身份重复观测；未交付确认对象不能 done；退休后足够新证据恢复；新释放附近真实初始 identity_ambiguity 经同帧分离与额外独立像素证据恢复；旧球遮挡重现；近邻位置不足、空帧、跨操纵、未知窗口与晚到边界撤销。

`raw/discovery/lifecycle-examples/` 保存 **12 组纯合成公开传感/模拟夹爪**的完整 observations、motions、records、支持/反对证据、action ledger 与 done 回执；目录 manifest 给出各文件 SHA256，`export_lifecycle_examples.py` 使用 create-only 输出。已知两球例真实执行 `Actions.execute(done)`，观测 13→14 后成功，额外普通发现仍保留；改为未知数量查询则拒绝。新释放竞争恢复例同样在真实 execute 的新观测 15→16 后成功。这些夹具隔离道路完成证据，未运行仿真、大模型或全任务脚本，不能视为正式任务成功。

旧 `tests/test_brain_stage2_discovery.py` 仅按新契约适配：保留原几何与冲突，v1 改 v2；普通框和已入库但有歧义的框现在有义务；新已解释视图允许 records 增长，原 unresolved/source 不消失。没有修改平台、vendor、原报告或历史 raw。

## 就绪与限制

源码与测试 SHA256 见 `raw/discovery/implementation-summary.json`；进入记录时 Git HEAD 为 `3ad444d03fc077e3d6215a2cf7165be1af2a7e5c`，工作区源码以所记 SHA 为准，HEAD 不代表已修改树。此为本子任务离线开发 READY，联合前置门及冻结版本由主任务确定。没有通用 resolver：多身份仍兼容、反对身份未同帧观察、视角不足或操纵状态未知时继续 pending，允许最终 FAIL。正式阶段 1 新候选回归、阶段 2 均未由本子任务执行或验收。
