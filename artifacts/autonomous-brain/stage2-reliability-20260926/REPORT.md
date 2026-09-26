# 本轮结果：离线修复已封存，联合前置验收 FAIL 后停止

停止时源码：`ba9edd36a773b896f9fe6e9eb37ed0f75e8e8a7c`。开发分支 `codex/autonomous-brain`，起点 `037593820f9d7aea77b4bb57d4b63f589e1eed01`。本轮正式运行 **0/2**、仿真运行 **0**、在线模型调用 **0**；阶段 1 新候选回归未运行，阶段 2 **未验收**，阶段 3、4 未启动。停止后仅进行证据封存和交付，没有继续修代码或重跑。

最终全量测试为 Python **1193 passed / 0 failed / 0 skipped**、Node **28 passed / 0 failed**，完整曲路换位合成诊断通过。但并行独立边界审查复现了一个未覆盖的异常路径，因此联合前置验收整体 **FAIL**：无 scheme 的合成模型服务地址通过模型配置形式校验，`urllib.request.Request` 在受控捕获外抛错，异常文本经真实 `run.main` 写入 rounds/summary，包含原地址。若地址携带敏感内容，会随异常落盘。复现没有读取实际配置、没有联网，合成 API key 未入日志；**不证明当前合法配置或历史证据已泄露**。遵照用户停止规则，不在本轮继续修补后再验收。

证据入口：[本轮 Release](https://github.com/54dK3n/wm_bench/releases/tag/stage2-offline-stop-20260926-ba9edd3)，[恢复说明](RESTORE.md)，[复核入口](REVIEWER_ENTRYPOINTS.md)，[最终门禁](FINAL_OFFLINE_GATE.json)，[边界审查](BOUNDARY_REVIEW.md)。原始证据只作 Release 附件，不入 Git。文件清单为 `SHA256SUMS`，压缩包哈希为 Release 同名 `.sha256` 附件；发布后的远端核验单独记录，不改变归档内原始结果。

## 实际修改与当前边界

| 项目 | 关键位置与结果 |
| --- | --- |
| R1 | `actions.py:203,275,428` 消费实际运动核验；失败终止动作、保留运动/抓放证据；未知执行状态只读复看，不盲目重发。环视按实际航向、有效新帧与相机视场覆盖计算；Runtime 落盘异常携带的动作证据。覆盖零/部分/完整旋转、重复帧、缺字段、异常中止、夹持异常。 |
| R2 | `tools/brain_evidence_audit.py:55` 与 `evaluate_autonomous_brain.py:559,867` 独立重算原始桥观测、全部相关框、同帧几何、释放边界、唯一候选、旧球排除与真实物体去重；不允许重复/冲突索引被覆盖。原始模型输出及全部调用严格回放；全局 Judge 与全动作前缀 Judge 分开。详见 `R2_RELIABILITY.md`。 |
| R3 | `perception.py` 将已交付、活跃、释放意图和待验证释放身份联合竞争；证据不足保留歧义，不凭距旧位置近贴旧标签；有充分新证据时仍能合法确认。无 frame 590、对象名或布局专用条件。 |
| R4 | `navigation.py:179,282`、`actions.py:992` 用实际进入/离开方向、出口对应、运动窗口与观测引用执行道路换位；保留弯道与超越路点核验。45° 门未改；反向候选与反向实际完成分离。 |
| R5 | `navigation_progress.py`、`actions.py:1123` 按规范目标/候选/路线版本/相关上下文记录失败；未到达不永久封禁位置；只换帧号不解锁，实质新路线可重评。 |
| 阶段 2 | 新 `road_evidence.py` 与 `navigation.py` 共用节点锚点、合并证明、实际有向行程及五态出口义务。blocked 仍待处理，未解决身份/连接不删账。独立 `tools/brain_topology_audit.py` 复算整个地图的端点范围、错误合并、重复节点、缺失节点及所有合法有向出口。分子/分母和 ≤1.2 口径事先记录在 `TOPOLOGY_SCOPE.md`。 |
| 完成与发现 | `task.py` 未知数量分支要求探索证据、当前红球消歧和持久发现义务；`perception.py:347` 保留未入 WM 的歧义红框。空画面或候选已交付标签不能清账。known 分支仍无需全图探索。没有通用发现消歧器；不能解释的义务会持续 pending，允许 FAIL。 |

脑端只读公开相机/内外参、里程计、局部道路和夹爪；真值及精确 render capture 只用于独立评测。没有替换 WorldModel、修改平台、放宽抓放/几何/运动门或扩大 200 轮/1200 秒预算。DeepSeek Flash、temperature=0、thinking=disabled 配置保持不变；没有启动在线运行。全部来源及依赖哈希见 `SOURCE_PROVENANCE.json`。

## 验证层次与命令

可靠性前置门先完成 **1045 Python + 28 Node 全通过**，其后才实现阶段 2。最终联合门的命令如下；其测试子项通过不抵消边界反例。

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_*.py
node --test tools/tests/test_autonomous_brain_*.js
python3 tools/diagnose_road_reposition.py --output <新的诊断文件.json>
python3 tools/verify_brain_revision_inputs.py --restore <隔离恢复旧证据的根目录> --out <新的核验文件.json>
```

原证据 79/79、隔离恢复副本 79/79、平台 58 个文件和 commit、WorldModel 50 个文件均未变。最终测试前后 79 个脑端/测试/工具源文件哈希一致；边界反例引用的 8 个源码哈希与该门一致。最终日志位于归档 `raw/final-offline-gate/`。开发中有意的红测试、夹具修正和失败迭代保留于各自目录，未删改为“从无失败”；完成门及正式运行单独统计。

完整道路换位是**合成传感/执行器诊断**：一次候选、一次到达、一次完整成功，3 次道路平移，实际里程累计 **42.2cm**，净位移 **36.0555cm**，候选误差 0；到达观测 12，内部新观测 13，最终观测 14，视觉距离 30cm。它不代表正式局成功，也不把旧 r102 的完整成功次数从 0 改为 1。

历史传感固定前缀诊断完整消费 594 帧：新规则消除了 590 的确定旧身份误贴，但对固定旧动作产生的 591 保守拒绝、保留第二次释放待验证。这是已保存开发源码哈希对应的固定输入分叉诊断，**不是新闭环成功**；后续增加持久发现账后没有将它冒充最终源码的再次执行。新行动后没有继续强行套用旧模型输出。

严格模型离线回放为历史 **111 轮 / 115 次调用一致，网络 0**，它验证记录的模型调用，不重新控制仿真。历史保存的转换证据另经 R2 新检查，249/591 仍可解释，全局 2 match / 2 unverifiable，前缀 4 match。该诊断与“用 R3 重新转换旧传感器”是两种输入，不能拼成一个分数。

## 历史结果保留与后续阻塞

原冻结源码 `d1538f7570a42b760ad518f133eaefd7bcac83a8`、报告 `4a48664eecd3f46984f9ca48674aefe53fd9518d` 及历史阶段 1 任务级 PASS 原样保留。原 111 轮、115 模型调用、594 观测、两个不同红球送达及模型 done 不作为本候选的成功数据。旧 [Release](https://github.com/54dK3n/wm_bench/releases/tag/stage1-known-two-20260926-d1538f7) 和原全局/前缀审计未改写。

下轮首要阻塞是 Request 构造失败时的配置异常脱敏，并需重新按用户批准的验收计划处理；本轮不自行开启新一轮修复。阶段 2 尚无正式拓扑/任务成功证据，保守道路假设和未解析发现可能导致失败。所有正式能力结论仍等待通过前置门后的真实自主闭环，不能用本轮单测或合成诊断代替。
