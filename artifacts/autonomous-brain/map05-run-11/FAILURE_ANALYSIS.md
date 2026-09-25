# Run11 失败分析 — 外部停止后导出失败

本局已结束，但正式停止导出失败。brain 报告 `BridgeError: follow_road: NOT_RUNNING`；driver 报告 `status: failed` 和 `CDP Runtime.evaluate timeout`。这是外部停止后的末轮执行失败以及另一个导出失败，不能归为模型请求失败，也不能称作完整导出的验收结果。

独立真值验收 **不可计算**；有效交付数保留 `null`，不是 0，也不是 1。仅能确认 brain 在 r37 报告一次传感见证通过的放置。没有运行缺少输入的独立 evaluator v2，没有复用其他局的导出。

| 可复算指标 | 结果 |
|---|---:|
| 轮数 / 模型调用 | 81 / 94 |
| 模型请求耗时合计 | 2149.2664976229994 秒 |
| brain 墙钟用时 | 2342.4428522079997 秒 |
| 仿真 / 最后观测 tick | 378.36 秒 / 18918 |
| 观测 / 成功写入 motions | 429 / 268 |
| 动作失败 / 外部停止失败 | 7 / 1 |
| 模型传输错误 / 状态校验错误 | 5 / 8，均在同次决策重试恢复 |
| 观测抓取成功 / 观测放置成功 | 1 / 1 |
| 独立有效交付 / Judge 真值分歧 | 不可计算 / 不可计算 |
| 配置上限 | 200 轮 / 1200 仿真秒，brain 记录未达到上限 |

请求错误为 1 次 RemoteDisconnected、4 次 HTTP 502；8 次状态校验拒绝均为 `go_to requires a CONFIRMED object`。81 轮最终都有动作；末轮是动作执行时收到 NOT_RUNNING。完整失败行、输入哈希和计算口径见 `run-metrics.json`。

## 观测时间线

| 事件 | 轮 / 观测 | 仿真秒 | 证据范围 |
|---|---|---:|---|
| target_023 首次出现 | r12 / obs53 | 44.60 | 公开视觉与 brain 跟踪 |
| target_023 确认 | r20 / obs91 | 75.60 | 多位置观测确认 |
| 首次 grab 后未持球 | r25 / obs113 | 90.70 | holding=false |
| 第二次 grab 后持球 | r25 / obs115 | 92.42 | holding=true |
| 5×6cm 后退验证通过 | r25 / obs120 | 95.62 | grasp_observed；原位匹配0，仍持球 |
| release 后观测 | r37 / obs216 | 194.76 | holding=false |
| 独立于 release 帧的放置见证 | r37 / obs217 | 197.44 | 单个球框/存放区框见证，非独立真值验收 |
| 放置后回到观测道路 | r37 / obs221 | 201.46 | onRoad=true |
| 最终公开观测 / 请求停止 tick | r81 / obs429 | 378.36 | tick18918；随后 follow_road NOT_RUNNING |

在最后保存的状态中有 27 个记账路口、24 个未探索出口，6 个未确认假设被保留为退役历史；没有第二个确认抓取。`pending_objects=[]` 仅是 brain 已知对象集合的状态，不证明地图上的任务目标已全部完成。没有成功的 done 动作。

## 证据缺口

以下六文件在 `map-05-run-1/` 下全部缺失：

- `record.json.gz`
- `samples.json.gz`
- `captures.json.gz`
- `sensor-audit.json.gz`
- `envelope.json`
- `evidence.json`

因此不能检查 gzip 完整性、record 是否完整、终端采样新鲜度、delivery 事件与最终真值位置的一致性、独立逐球误差、Judge 分歧，以及 record 侧的越权调用审计。原有 `evaluation-map.json` 和 `evaluation.json` 不能补齐这些导出。归档未读取 evaluation-map 内容，也未把其中信息送入 brain。原始 record 大小及 SHA256 均为空；现存文件没有达到 100MiB，无需分片。

brain 自己保存的 1986 条 bridge 调用均属于预先公布的方法，1985 条完成、最后一条 follow_road 因 NOT_RUNNING 失败。这个记录内检查不能替代缺失的 record/传感审计。

## 停止原因与缺陷的边界

评测方在 tick18918 请求停止，原因是离线公开传感契约复现出四次90°端点扫描的覆盖空隙。该复现没有证明它是本局未完成的唯一物理原因。另有道路记账的传感器日志复现，见 `artifacts/autonomous-brain/road-memory-audit-20260925/REPORT.md`：r76 可精确复现把当前观测中不存在的历史出口标为完成；r75 的原路返回出现相同出口签名重新建点。这些发现也不单独证明唯一失败因果或物理路口身份。

`evaluator-stop-cdp.json` 保留停止元数据原始精确字节；`evaluator-stop.json` 仅将 result 解包为返回的 backend status。timestamp、reason、tick 均不变，原文件 SHA256 写入规范化版本。driver 后续 `RobotBackend.stop('finished')` 的导出发生超时；未把临时浏览器已关闭后的缺失数据描述为已恢复。

## 可用证据核验

冻结提交 `913474816dbd6271d223cf0cf79366ff668b1e42` 的七个 brain 文件及 driver 共八文件，与运行前 manifest、运行后 summary、brain 自记哈希逐文件吻合；driver 的 `sourcesUnchanged=true`，platform/capture 的前后哈希一致。具体字节哈希见 `source-commit.json`。当前工作树后续修复不参与该证明。

严格离线 LLM 重放 PASS：81/81 轮、94/94 调用，完整记录除 mode 外一致，全部耗尽，网络调用0、环境读取尝试0、原始证据不变。它不重放仿真，也不替代任务验收。见 `llm-replay/replay-checks.json`。

指标从 `map-05-run-1/brain/` 五份 JSONL 和 summary 复算：条目数量直接计数、模型耗时求和 `elapsed_s`、仿真用时取公开观测最大值、失败按 result.success 分类。原始可用文件逐项字节数与 SHA256 见 `archive-integrity.json`；前十局保留核验见 `archive-checks.json`。
