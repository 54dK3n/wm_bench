# R2：正式评测观测证据核验

本文件记录可靠性阶段的离线修复与诊断，不是新正式任务结果，也不改变阶段 1 历史 PASS。当时阶段 2 拓扑验收保持关闭；后续实现及本轮停止原因见本轮主报告。本分工没有运行仿真或调用模型。

## 函数级复现

`tools/probe_task_scope_geometry.py` 在 `--repo` 指定仓库读取冻结提交的原 evaluator，并记录完整源码 SHA256、`evaluate_task_scope` 的 AST SHA256，然后用一致合成桥观测/转换证据/账本/动作引用放置区外球框。原 `ball_inside_region` 返回 false，冻结函数仍返回空 failures；候选函数明确拒绝 `delivery_unique_geometric_witness_not_verified`。这只是函数级反例，未宣称原 `evaluate_run` 会接受该合成局。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tools/probe_task_scope_geometry.py --repo . \
  --out /tmp/wm-r2-function-probe-new.json
```

既有输出：`raw/evaluation/r2-geometry-function-probe.json`。原 evaluator SHA256 为 `71c0b7410e29cd4859e2c0fdea4b6b8897d5f4ff96a3fb9aafb4013ca822b6be`；原函数 AST SHA256 为 `17d6e06e4c505636a835c7695db7acb3dc135c5966e5e4f687d1f3397252cbe9`。未收到外部 `review_probes.py`，本脚本与拒绝性测试是独立重建。

## 实际修改

- `tools/brain_evidence_audit.py`：独立重建索引，重复或冲突的 observation index/frame、bridge request/frame 不允许字典覆盖。原始桥 observe 返回必须逐项等于脑观测；每帧夹爪读数必须新鲜。放置球/区域转换框必须唯一对应原始检测，所有相关原框均参与，不能删除第二候选的转换记录或位置来形成虚假唯一性。
- 同模块重算未改动的 `ball_inside_region` 几何门、全部候选配对、释放之前的已知对象集合、旧球的单独可见证据、真实 release 命令与 holding 变化、释放后新帧/时间边界、先前有效 pick、动作结果与账本引用。未知旧身份标签、歧义 witness、重复身份或重复像素 witness 均拒绝。
- `tools/evaluate_autonomous_brain.py` v6：新检查接入正式 task scope。对所有 pick/place 统一输出“动作之前全部观测前缀”的 Judge；原全局 Judge 独立保留。用于完成计数的每个 witness 另须通过同 frame/tick 的原像素几何真值对应，与该释放动作之前的身份相符；旧球排除标签也须对应先前已核验的物理对象，不能在不同帧重复计入同一个物理球。
- 已计入完成的成功动作若被对应原生动作窗口明确反驳，则阻止完成；历史 `unverifiable` 不整体改成 fail 或 match。每项保留具体原因，只有影响当前完成要求的证据缺失/冲突才进入新完成门禁。
- `done` 从实际 response body 严格解码，不只比较已经解析的 action；核对原始输出、请求哈希、正常结束以及后续新观测与重算 completion。所有任务感知正式评测还调用既有严格离线回放工具，重新验证全部轮次/调用、请求与完整响应记录，临时输出不覆盖输入；网络和环境访问均被该工具拦截并计数。
- v8 源证明要求 `evaluatorDependencies` 覆盖新 helper 与原 `tools/replay_brain_llm.py`，v7 历史证明口径保持不变。新评测结果也记录实际 evaluator 依赖 SHA256。

负例包括区外框、多球/多区域候选、旧球代新球、伪造旧标签、原始框对应转换被删除、候选位置被删除、身份歧义、释放前帧/错误时间、重复 frame/index、原桥数据篡改、陈旧夹爪、账本/动作引用不一致、缺 grab/release、不同身份复用同一物理球、模型只有 parsed done 而实际输出不符、请求哈希篡改及没有 done 后新校验。正向对照使用完整合成传感日志；没有把接口 completed 当作效果证明。

## 验证记录

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q \
  tests/test_brain_evidence_reliability.py tests/test_brain_stage1_evaluation.py \
  tests/test_brain_evaluation.py tests/test_brain_evaluator_dependencies.py \
  tests/test_brain_stage1_source_proof.py
```

结果 **145 passed / 0 failed**，日志 `raw/evaluation/r2-pytest-complete.txt`。这包含 R2 新拒绝/正向对照、既有评测、阶段 1 与 v7/v8 源证明回归；不是正式运行数量。前两项早期失败是合成真值 fixture 将同一 ID 重复放入两个位置，原像素 matcher 因而正确返回 ambiguous，测试期待的更后级原因未触发；已改成两对象交换身份的有效负例，未降低拒绝规则。

## 历史原件的只读新诊断

输入来自 Release 证据包的隔离恢复目录，原 79 项清单已由主任务核验。本次将候选 evaluator 的输出另写至 `raw/evaluation/r2-history-readonly-complete/`，不覆盖任何原评测。命令：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/evaluate_autonomous_brain.py \
  --input artifacts/autonomous-brain/stage2-reliability-20260926/raw/restored-evidence/artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --out /tmp/wm-r2-history-diagnostic-new
```

新诊断中，原保存转换证据的 witness 249/591 都通过桥观测、原几何、释放边界、唯一候选、动作引用和不同物理身份检查。原全局 Judge 仍为 **2 match / 2 unverifiable**；统一四动作前缀 Judge 为 **4 match**。严格模型回放为 **111 轮 / 115 调用全部一致，网络 0、环境读取 0**，原件 SHA256 未变。

这项诊断读取历史日志中保存的转换证据，解释原 witness 为什么有效；它没有用 R3 新身份关联算法重新生成历史转换记录。R3 对固定旧传感输入的新算法诊断（例如 591 保守歧义）是不同实验，必须单列，不能拼接或回写旧局。本轮仍需主任务完成 R1–R5 联合门，再决定是否进入阶段 2 离线实现及后续正式验收。
