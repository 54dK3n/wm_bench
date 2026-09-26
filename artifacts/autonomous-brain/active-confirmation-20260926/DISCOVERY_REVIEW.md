# 主动确认采样复核

本文对应冻结源码 `dec5b078d6711bdfda972ca4632c200e235dfb7e`，依据公开脑日志、旧模型文字回放和合成联动证据。它说明本轮改动与限制，不判定正在运行的新正式局成败；未读取新正式局真值，未重跑模型或仿真。冻结来源见 [FROZEN_INPUTS.json](FROZEN_INPUTS.json)。以下 `raw/` 入口需从本轮证据附件恢复，不提交完整日志到 Git。

## 旧局统计的三个层次

输入是上一轮 `recovery-closure-20260926` 正式局的公开 `brain/rounds.jsonl`、`observations.jsonl` 和 `summary.json`，不是新局结果。原始字节 SHA256、逐框关联及脚本保存在 [全局公开链](raw/discovery/previous-public-chain.json)、[后期采样链](raw/contract/public-sampling-diagnostic.json)；复算入口为 [audit_previous_public_chain.py](scripts/audit_previous_public_chain.py) 和 [public_sampling_diagnostic.py](scripts/public_sampling_diagnostic.py)。不调用生产 Perception 重放，不读取 record/capture/evaluation。

| 范围 | 原始检测 | 送入 WM | 有效 hit | 可得结论 |
|---|---:|---:|---:|---|
| 全部 200 轮、1118 次观测 | 295 条红框 | 34 条 `fed_to_world_model=true` | 15 次 | `target_017` 为 4 次，其余 11 个跟踪假设各 1 次 |
| r78 最后一次成功 place 之后新出现的 7 个候选 | 这里只统计其 fed 子集 | 17 条 | 7 个首个 hit | 每候选均 1 hit，首个 hit 后新增独立平移位姿 0，新增 CONFIRMED 0 |

有效 hit 按检测的原 frame_id 是否出现在该观测对应对象的 `hit_poses` 联结；送入次数不等于独立命中次数。后期 7 个 ID 为 `target_135/140/141/151/159/161/172`，fed 条数依次为 `1/4/3/1/4/1/3`。对每个 ID，其 fed 观测间最大平移均为 0；原地改朝向和重复观测不满足原有至少 15 cm 的独立位姿要求。“0”指首个 hit 之后的新增位姿，不是否认首个有效位姿。

r79–200 共 **122 个高层 explore 决策**。这个动作计数不能解释成机器人未移动；上述“位姿 0”只限于每个候选被送入 WM 的观测子集。旧 summary 中最终 `discovery_evidence.unresolved` 有 **225 条记录、按 hypothesis_id 去重后 182 个未解释假设**，并非 182 个物理球；7 个 track ID 同样不证明 7 个物理球。旧正式结果保持原样。

## 契约和摘要修复

六个动作不变。LLM v18 的 explore 参数仅允许互斥的 `{}`、`exit_angle` 或 `discovery_id`。新 ID 必须是当前有界 `discovery.pending` 中唯一行的稳定 `id/hypothesis_id/source_discovery_id`，为非空且最多 128 字符；`latest_discovery_id` 只作证据引用。新意图请求取得确认，不抓取、不交付，也不替代模型选择后续动作。go_to/pick 仍只接纳当前 CONFIRMED 对象。

旧摘要依赖字典最初插入次序的最后 6 项，更新老假设不会改变其插入顺序。本轮按当前可见、可采样和真实独立进展排序，并纳入 active TENTATIVE/STALE。同一明确活跃对象只在摘要内折成一行，原发现、竞争、关联及操纵边界账本完整保留。`pending_count` 是全部未解释假设数，`pending_record_count` 是其记录数，`candidate_count` 还包含待确认跟踪对象；最多 6 行的摘要不能代替这些总数。

旧日志有 35 个决策的“最后插入”与“最新记录”选择不同，另有 10 个决策的当前 TENTATIVE/STALE 红框因不属于 unresolved 而未进入旧摘要。但**当前帧仍属 unresolved 却被 last6 遗漏的旧局决策数为 0**；函数级红例证明此缺陷可发生，不能写成旧局已发生该特定遗漏。生产排序使用独立进展，不以最新 frame 号冒充进展。

recent 动作摘要已保留 discovery_id、采样的真实 hit 增量/行程/失败理由，以及道路和目标分类进展；原先的参数白名单会丢掉新意图，本轮已补齐。原始 steps/完整帧不进入 recent；标量字符串最多 256 字符，进展 ID 列表最多 12 项、每项 128 字符，viewpoint_constraints 最多取前 6 项字符串、每项 128 字符。

版本为 LLM v18、Runtime v16、Actions v24、Navigation v10、Perception v12、采样模块 v1；发现账本仍 v2，driver v9/evaluator v8 不变。WM 确认/关联门、resolver 条件、平台和 vendor 未放宽。新顶层采样模块由现有 driver 全源码 manifest、Runtime 字节哈希和起止来源校验共同覆盖。

## 验证和已知限制

v1–v17 文字回放按各自原白名单、原提示词、状态、模型原文及修复文字验证，不接受新 discovery_id。上一轮 v17 **200/200 决策轮、203/203 请求严格回放 PASS**，全部原记录消费，除 mode 外完整相等，网络调用与环境访问均为 0，原证据 SHA256 不变。见 [replay-checks.json](raw/contract/historical-v17-replay/replay-checks.json)。这是离线文字回放，不执行原动作，不构成旧局重新验收。

冻结前联合门为 **1448 Python、29 Node、15 平台边界检查通过**，无失败或跳过；开发子集重叠，不相加。完整命令与先红后绿入口见 [TEST_COMMANDS.md](TEST_COMMANDS.md)、[GATE.json](GATE.json)、[TESTS.json](TESTS.json)。其中合成联动使用真实 Perception/WM/Runtime/Actions 和实际平台参数规范化，场景几何只由测试夹具生成公开像素，不传入脑端；它与历史文字回放分别证明不同性质，均不代表正式任务通过。

采样按原 3 次有效 hit、15 cm 独立位姿门取得确认；转向和回到旧位姿不增加独立 hit。每步重新感知，距离越窗、竞争、身份改变、无证据倒车、未知运动或超预算均停止；最多 12 步，请求受 120 cm 剩余行程约束，实际超过 120 cm 拒绝成功。最终还需新的当前唯一可见确认，历史 CONFIRMED 状态不能替代后置 fresh 检查。未知回执不会自动重发运动。

**强 far-clipped 仍是保守限制。** 初始 raw_distance=100 的合成公开输入，在一次有界接近后因原 source 缺少严格新帧关联而返回 `confirmation_needs_fresh_observation`，没有生成 WM 对象，见 [sampling-clipped-review.json](raw/contract/sampling-clipped-review.json)。不能将约 97 cm 的窗外接近正例推广成任意饱和远场都已闭环，也不能自动把新 hypothesis 绑定成原身份。若没有安全独立视角，系统保留缺口和具体原因；本轮不通过降低确认门弥补这个限制。
