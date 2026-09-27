# 逐次抓取授权与采样恢复：局部通过，预检 HTTP402，正式未运行

冻结候选 [`4fa8916f8570b467983c86337a46dc5d1b900cde`](https://github.com/54dK3n/wm_bench/commit/4fa8916f8570b467983c86337a46dc5d1b900cde)。五项缺口已复现、修复并通过联合局部门；**一次独立服务预检仍返回 HTTP402，因此本轮新阶段1正式局未运行**。没有恢复旧中断局、重试服务、充值、换模型/端点，阶段2、十布局与真机未启动。HTTP状态本身不能证明账户原因。

预检为固定合成文本，DeepSeek Flash / temperature=0 / thinking=disabled；实际请求 **1** 次、记录耗时 **0.771802秒**、机器人未连接。它不算正式模型任务成绩。阶段1新候选是否能完成两球仍未验收，不能把局部测试通过写成正式 PASS，也不能把这次未启动任务写成新正式 FAIL。详见 [METRICS.json](METRICS.json)。

## 修复与验证

| 项目 | 结果与入口 |
| --- | --- |
| P0 逐次 grab 授权 | 已修复。`Actions.pick` 每次真实命令前重查当前规范身份、CONFIRMED、唯一关联、空夹爪和原几何；实际命令与实际前置帧逐次绑定。`Perception.mark_picked` 核对保存的原授权，unknown 回执保留原 pending，不重发。失效可沿本次已测安全路径复看，但仍返回失败，须新证据与新决策重新 pick。18 项新增测试覆盖要求的九类场景及篡改/净空边界；[抓取复核](GRAB_REVIEW.md)。 |
| P1 连续逆向支持 | 已修复。`_reverse_support/_recorded_translation_support` 支持同一路径20、10+10、5×4的连续原段，逐窗核对动作、端点、方向、里程、节点和新鲜净空。断链、平行偏移、曲线、未知中途节点等继续拒绝；[采样复核](SAMPLING_REVIEW.md)。 |
| P1 backward 后恢复 | 已修复。`_restore_plan/sample_discovery` 在原有效视角、实际直线路径、当前净空和原剩余预算均满足时执行 forward 逆向恢复；统一 forward/backward/turn 的原记录核验。回到旧位置不算新增 hit，恢复后须重新看见同一目标。与逆向支持合计40项新增测试。 |
| P1 失败视角循环 | 已修复。`SamplingProgress` 比较所有已失败等价上下文并合并别名义务；0→10→0、新frame、同tick不能自行解锁。真实新hit、相关净空或严格验证的新安全路径可以重新评价。6项新增测试；[进展复核](PROGRESS_REVIEW.md)。 |
| P1 审计版本契约 | 已修复。显式声明v1–14旧兼容规则、v15–17必需命令链、v18逐次授权证据。缺失/未知版本拒绝；原始像素/对象与命令引用独立复算，不相信 authorized=true。133项新增完整审计入口正反测试；[审计复核](AUDIT_REVIEW.md)。修前证据是完整账本审计函数反例，**不是已有整局伪造PASS反例**。 |

Runtime v18、Actions v26、Perception v14、采样记录v3、进展记录v2；LLM v19参数与prompt不变，旧转录保留原版本语义。原三有效hit、15cm位姿、40≤raw<90cm/35°确认门、抓放门及预算全部保持。白名单、平台58个运行源文件/资源和实际WM包14个源文件哈希不变；未扩大平台权限或把真值/布局信息送入大脑。原短段、候选筛选、节点区域、基础逆动作和探索语义回归仍保留。

## 分层证据

| 层次 | 最终结果 |
| --- | --- |
| 函数与相关完整回归 | **Python1717、驱动29、冻结平台契约15项通过；0失败、0跳过**。Python包含201项新增测试，按五个新文件合计133+18+40+6+4；4项为独立服务预检工具测试。开发中红例和夹具/环境失败原日志分别保留，不与最终通过数相加。 |
| 真实生产者→独立消费者合成联动 | 抓取9场景均满足成功或拒绝预期，保存原公开观测、motion、桥调用、决策窗口及独立审计。拒绝场景没有非法抓取/交付账本；这不是9条正式交付链。采样5代表场景保存连续段、恢复及真实WM命中；全部检查通过。每个运动经冻结normalizeCommand。 |
| 历史模型转录 | a847a3c的v19原记录 **97轮/97调用**严格离线回放通过，网络调用0；包括HTTP402终止，不续跑物理动作。 |
| 原r34抓放链 | 用当前审计只读复核，实际grab `brain-000854` 前o184仍为STALE，继续拒绝；后续release级联失败保留。五份旧公开输入SHA前后相同。 |
| 单独真实服务预检 | **1请求，HTTP402，停止**；无机器人、无重试。 |
| 新正式阶段1/阶段2 | **均未运行**；没有新的物理交付、DELIVERED、Judge或done成绩可报告。 |

[GATE.json](GATE.json) 保存测试分布、选定源码/AST及证据哈希；[TEST_COMMANDS.md](TEST_COMMANDS.md) 给出命令和范围；[FROZEN_INPUTS.json](FROZEN_INPUTS.json) 固定源码、平台、WM、依赖、模型参数及评测器。该文件里的 `source_manifest.modelConfiguration.formal_run=true` 仅为原驱动返回的配置资格字段；顶层正式状态是 `NOT_RUN`，不是运行证明。

## 历史结果不变

历史d1538f7阶段1 PASS、1117336 FAIL、dec5b07 FAIL保留。上一轮a847a3c阶段1 **FAIL**、阶段2未运行：r97/673.06仿真秒HTTP402，97次模型调用、596次观测，未用完200轮/1200秒。本局有**1次完整候选换位成功（2次尝试、1次到达）**，不能说从未成功换位。

上一轮脑端与record各记1球送达，但独立观测命令链验收0条；全局/前缀Judge各2match不抵消r34第二次grab前STALE及后续交付引用的级联拒绝。原件与结论仍见[上一轮Release](https://github.com/54dK3n/wm_bench/releases/tag/executable-recovery-20260927-a847a3c)，本轮不覆盖旧报告或原局。

## 交付与停止

源码在 `codex/autonomous-brain` 普通推送；冻结标签 `grab-sampling-contract-20260927-4fa8916` 指向上述完整SHA。报告及发布验证是其后继提交；最终远端完整HEAD另从远端读取，见 `PUBLICATION_VERIFICATION.json`。未force push、回退或重写历史。

[本轮Release](https://github.com/54dK3n/wm_bench/releases/tag/grab-sampling-contract-20260927-4fa8916) 提供原始证据包、[SHA256SUMS](SHA256SUMS)、[恢复说明](RESTORE.md)、METRICS、REVIEW和报告。包名 `wm-bench-grab-sampling-contract-20260927-evidence.tar.gz`；原文件及容器SHA、成员一致性见DELIVERY.json和同名.sha256，上传前检查见SECRET_SCAN_RAW.json/SECRET_SCAN.json。raw仅Release，不进Git、不拆bin、不改验收原件。发布后完整匿名下载复验另存PUBLICATION_VERIFICATION.json。

当前停止于局部修复候选的交付。服务可用性门未通过，尚不具备继续阶段2的验收条件；本轮不再请求模型、不补跑正式局。
