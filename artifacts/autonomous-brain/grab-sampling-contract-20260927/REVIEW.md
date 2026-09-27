# 本轮修复范围与复核入口

审查基线 `10e3c879d2499d6f893151f24857c315f12fe2e7`。开始时远端 `codex/autonomous-brain` 与本地 HEAD 一致、工作区干净；原始选择与远端读回保存在 `raw/baseline/`。原函数探针按用户提供的反例描述迁入仓库，没有接到另一个可执行审计包；不能把自建探针称为外部 reviewer 原脚本。基线源码/AST 指纹与修复后 GATE.json 的源码/AST 分别保存，不替换旧指纹。

| 问题 | 实现与复核 |
| --- | --- |
| 每次真实 grab 的当前授权 | `Actions.pick` 每次接近及真实命令前重读当前规范对象；`Perception.authorize_grab` 绑定当前 CONFIRMED、身份唯一性、空夹爪、原几何及该次命令。`grasp_confirmation_chain`、`mark_picked` 保存并核验实际成功命令；unknown 回执保留 pending，不重发。见 `GRAB_REVIEW.md` 和 `tests/test_brain_grab_authorization.py`。 |
| 逆向支持与记录分段无关 | `_reverse_support/_recorded_translation_support` 验证连续实际段和完整原观测窗口，20、10+10、5×4 对同一路径给出一致支持。断链、侧偏、弯曲、未知中途节点和预算/净空不足仍拒绝。见 `SAMPLING_REVIEW.md`。 |
| backward 失视后的正向恢复 | `_restore_plan/sample_discovery` 对刚执行的实际直线路径使用同一逆向证据；恢复消耗原 12步/120cm，最多一次。回到原位、目标重新出现、新 hit 和确认分别核对。 |
| 失败视角循环 | `SamplingProgress.find/readiness/new_evidence` 保留所有失败条件及别名义务；0→10→0 不借最后一次失败清空旧条件。`Runtime.observe` 只将严格验证的有限逆路径能力作为新路径依据。见 `PROGRESS_REVIEW.md`。 |
| 审计版本契约 | `RUNTIME_EVIDENCE_CAPABILITIES` 显式声明历史与当前必需字段。v15–17 必需原抓放命令链，v18 增加逐次授权原证据；缺失/未知版本保守拒绝。独立审计从原公开观测和命令复算，不信 authorized 标志。见 `AUDIT_REVIEW.md`。 |

原基础段逆运动、预期节点区域连接、短段聚合、候选截断前筛选和探索结果语义保留。Runtime v18、Actions v26、Perception v14、采样记录 v3、采样进展 v2；LLM v19 的六动作参数与原 prompt 不变。旧转录按自己声明的版本回放。

正式模型仍为 DeepSeek Flash / temperature=0 / thinking=disabled。原三有效 hit、15cm 独立位姿、确认窗、抓放几何、200轮/1200秒、最多三候选与共享45步换位预算不变；没有平台真值回流、权限扩张、固定全任务脚本或平台/WM 重写。

历史 a847a3c 局仍为阶段1 FAIL、阶段2未运行；r97/673.06仿真秒 HTTP402，97次调用/596次观测；1次完整换位成功（2次尝试/1次到达）；脑端和 record 各1交付、独立交付链0。全局/前缀 Judge 各2match 不覆盖 r34 第二次 grab 前 STALE 的拒绝。历史 d1538f7 PASS、1117336 FAIL、dec5b07 FAIL 不变。HTTP状态不能确定账户原因。

函数反例、合成传感联动、历史模型转录回放、独立服务预检和正式运行分开计数；最终测试与运行状态以 REPORT.md、GATE.json、METRICS.json 为准。raw 只通过本轮 Release 提供，Git 保留脚本、摘要与校验/恢复入口。
