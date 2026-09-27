# 可执行路径与采样恢复：局部通过，正式阶段 1 FAIL

冻结源码 [`a847a3c538c2787864633753b74dd906098ff6fd`](https://github.com/54dK3n/wm_bench/commit/a847a3c538c2787864633753b74dd906098ff6fd)，审查基线 `d68bddc2aa6ddca734add829f23127ee9e05fe50`。开始时 HEAD 与基线一致、工作区干净；在 `codex/autonomous-brain` 上保留已有修改，普通推送到 `54dK3n/wm_bench` 并从远端重新读取完整 SHA。没有 force push、回退或重写历史。

本候选唯一一次正式 map-05 阶段 1 **FAIL**。指令为“把两个红球送到绿色存放区”，第 **97 轮**模型接口返回 **HTTP 402**，在 **673.06 仿真秒**结束；共 **97 次模型调用、596 次观测、2787 次桥接调用、白名单外调用 0、done 0**。没有用完 200 轮/1200 秒预算。HTTP 状态本身不足以在本报告中断言账户原因，也不能据提前终止推断候选一定会在完整预算内成功或失败。

脑端记账和独立 record 均记录 **1 球送达**；但冻结的观测命令链审计通过 **0 条交付链**，不能称为“1 次已完整验收的有效交付”。阶段 2 **未运行、未验收**，十布局与真机未启动。正式失败后没有修脑端或评测器、没有重跑或补充仿真。

历史 d1538f7 PASS、1117336 FAIL、dec5b07 FAIL 原样保留。dec5b07 的第二候选曾在 r105 确认、r106 起接近/换位受阻的结论不改写；本轮是独立新局。历史全局 2 match / 2 unverifiable 与前缀 4 match 也未覆盖。

## 修复及保持的判据

| 范围 | 实现与关键入口 |
| --- | --- |
| 道路段的执行语义 | `navigation.py::_record_approach_segment/approach_candidates` 分开基础平移、道路跟随和出口段，记录车体朝向、运动方向、道路切线及操作方向；基础段逆向使用对应原语。`actions.py::_approach_basic_plan/_follow_approach_path` 根据原记录和当前净空执行、复核实际位移与航向。不能执行的路线在截断前三条前筛选，不删除全部基础边。 |
| 预期节点区域连接 | `_approach_node_connection` 区分进入检测区域与完成历史锚点；有历史直线、入口、出口及新鲜净空证据才走剩余连接。保留节点身份不确定，不凭 atNode 提前消费路段或合并节点。 |
| 采样视点比较与恢复 | `confirmation_sampling.py::_plan` 比较当前前/后移动和有限转向后继方案，保留相机偏移与窗口检查；失视最多一次返回有记录支持的有效视角。恢复计入原预算；小于平台 1° 下限的恢复转向明确拒绝，不钳制。 |
| 无进展约束与模型交接 | `SamplingProgress`、`Perception.sampling_readiness` 保存目标、命中和失败上下文；待处理义务与可执行采样候选分开。同帧抖动不能解锁。普通 explore 内转向后出现新的有效目标视角时可在 take_exit 前交回模型，最终再观测仍须确认机会保留。 |

Actions v25、Navigation v11、Perception v13、Runtime v17、LLM v19、采样记录 v2。v1–v18 模型记录仍按各自原契约解释；没有重写旧 prompt 或旧转录语义。

DeepSeek Flash / temperature 0 / thinking disabled、六种高层动作、传感器/执行器白名单保持。原确认门为三个有效命中、`40 <= raw_cm < 90`、`|bearing| <=35°`、独立位姿至少 15 cm；规划仍采用 42–87 cm、33° 和额外 .2 cm 裕量。抓放、完成门、全局 200 轮/1200 秒、采样 12 步/120 cm、最多三个换位候选及共享 45 步预算未放宽。平台、WM、正式驱动和评测器字节均未改变。

## 验证层次

| 层次 | 结果及范围 |
| --- | --- |
| 函数反例与完整回归 | Python **1516**、驱动 **29**、冻结平台 **15** 项通过，无失败/跳过。开发中环境监听失败、提供器修正和真实红例分别保留，不能相加为更多独立测试。 |
| 合成公开传感联动 | 真实 Perception/WM 的逆路径→对应原语→节点区域→重新观测→视觉接近组件 **10/10** 检查通过；新 **10** 个视点/恢复场景及旧 **16** 个采样场景全部满足各自成功或拒绝预期。不是假 WM 返回确认，也不是正式局。 |
| 冻结平台局部诊断 | 无模型、无真值读取、无跳点。按公开净空执行 **17.1 cm** 斜向基础段并由生成候选选择 backward 逆走，归位位置与车体航向误差均 **0**；共 **12** 次运动、**10.32 秒**。当次扫描后可执行采样候选为 0，没有原生采样确认成功。 |
| 历史模型文字回放 | dec5b07 的 v18 转录 **200 轮/206 调用**严格一致，网络/环境访问 0；不重做物理动作。 |
| 本轮正式运行 | 唯一阶段 1 **FAIL**；新 v19 转录 **97 轮/97 调用**严格回放通过，网络/环境访问 0。回放通过不替代任务验收。 |

[GATE.json](GATE.json)、[TESTS.json](TESTS.json) 保存最终同候选源码/证据哈希和测试分布；[TEST_COMMANDS.md](TEST_COMMANDS.md) 给出实际命令与复算入口。[REVIEW.md](REVIEW.md) 区分外部探针未提供、按描述自建探针及所选 `--repo`/AST 指纹；旧源码指纹没有被改写成新源码。

## 正式局的采样与可执行路线

完整公开日志复算为 **163 条原红框、37 条 fed 检测、12 个唯一 (track, frame) 有效 hit、3 个红球轨迹身份**；它们既不是同一种计数，也不是三个物理红球的证明。

- r8 普通探索内部交回一次有效采样机会，最终新鲜观测仍保留。
- r9/r24/r25 共 **3 次**定向采样、成功 **0 次**。r9 实际走 15.5 cm，为选定 target_017 新增 **1 个独立 hit**，但未达到三次确认。r24 走 17 cm 后的新增红轨迹首 hit 属于另一条跟踪，不记作选定目标进展；恢复判定 1 次因前视角不满足原门而拒绝，实际恢复原语和成功均为 0。r25 无安全独立视角、零运动。采样窗口所有红轨迹新 hit 为 2，选定目标新增为 1，分别保留。
- 本局唯一曾 CONFIRMED 的红轨迹 target_027 在 **r30/o113**确认。r31 首次 go_to 受未记录的中途节点影响而停；r33 经有据后继路线完成候选换位并重新观测，通过原视觉 standoff 门。
- 正式局实际候选尝试 **2** 次、候选到达 **1** 次、**完整换位成功 1 次（r33）**。完整成功要求当前 go_to 成功且 `road_reposition.status=reposition_and_visual_standoff_verified`；只移动或接近候选不算成功。查询日志累计枚举 6、合格 6、返回短名单 5，是查询事件行数，不是独立位置数。

r31 的控制阻塞后来已恢复，不能写成整局持续终因。本局没有第二个已确认红轨迹，但也不能据此改写 dec5b07 的已确认事实，或把本局 HTTP 402 简化成“第二候选未确认”。具体最早道路受阻、采样阻塞、已确认目标接近阻塞及后继恢复见 [FIRST_BLOCKER.md](FIRST_BLOCKER.md)。

## 抓放引用链的独立拒绝

r34 的第一次 grab 未抓到，第二次 grab `brain-000854` 前的 o184 已将 target_027 标为 **STALE**；冻结审计要求命令前状态为 **CONFIRMED**，因此拒绝 `pick_command_identity_confirmation_chain_invalid`。随后 r52 的 release 自身引用可对应公开命令，但其 `grasp_request_id` 没有进入已验证抓取集合，产生 `delivery_release_command_reference_invalid` 和 `delivery_missing_prior_verified_pick` 两项级联拒绝。

原全局 Judge 和动作前缀 Judge 各为 **2 match**，身份审计无失败；这只对应各自口径，不能代替命令前状态与完整交付证据链。没有删除冲突状态、将 STALE 当成 CONFIRMED 或修改评测器来消除这些拒绝。证据与复算入口见 [EVIDENCE_CHAIN_REVIEW.md](EVIDENCE_CHAIN_REVIEW.md)。

## 正式命令、冻结与停止

```sh
PYTHONDONTWRITEBYTECODE=1 node tools/autonomous_brain_driver.js --out artifacts/autonomous-brain/executable-recovery-20260927/raw/formal-stage1 --maps map-05 --runs 1 --task '把两个红球送到绿色存放区' --max-rounds 200 --max-simulation-seconds 1200
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/executable-recovery-20260927/raw/formal-stage1/map-05-run-1 --out artifacts/autonomous-brain/executable-recovery-20260927/raw/evaluation/formal-stage1
```

两个进程退出码均为 1。完整 stdout/stderr 分别为 `raw/formal-driver.*.txt` 与 `raw/formal-evaluator.*.txt`。报告将 51 次失败动作与 r97 的 1 次执行/模型异常分开；评测原有宽泛 `execution_or_controller_error` 标签保留。没有重试 HTTP 请求或恢复本局后补跑。

[FROZEN_INPUTS.json](FROZEN_INPUTS.json) 固定源码、平台、实际加载 WM、配置和评测器。独立 `source_proof=verified`：运行前后 manifest 相同，brain/driver 13 文件对应，实际 WM 和配置一致。开发及公开诊断不读取真值；冻结独立评测在评测侧使用原评测附件，没有回流到大脑。

## 交付

[独立 Release](https://github.com/54dK3n/wm_bench/releases/tag/executable-recovery-20260927-a847a3c) · [指标](METRICS.json) · [逐文件 SHA256](SHA256SUMS) · [恢复说明](RESTORE.md)。包名 `wm-bench-executable-recovery-20260927-evidence.tar.gz`；原件/压缩包的 SHA256、大小和一致性见 `DELIVERY.json` 及同名 `.sha256`，上传前扫描与分类见 `SECRET_SCAN_RAW.json` / `SECRET_SCAN.json`。匿名完整下载验证另存 `PUBLICATION_VERIFICATION.json`。

raw、record、完整观测和模型日志仅在 Release 包中，不加入 Git、不拆成 bin、不为上传改写原件。报告提交与发布验证提交均在冻结源码之后，远端最终完整 HEAD 在交付时重新查询。当前停止于证据交付，不继续开发或运行下一阶段。
