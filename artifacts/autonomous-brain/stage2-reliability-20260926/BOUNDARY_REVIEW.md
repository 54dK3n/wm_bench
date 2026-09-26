# Runtime 边界审查（2026-09-26）

结论：发现一项敏感配置异常落盘缺口。现有离线边界回归 **97 passed**，但合成反例成立；主任务据此将联合前置验收判为 FAIL 并停止。本文不构成正式运行或真值评测 PASS。审查未修改源码、测试、旧报告，未运行仿真或模型，未读取真实 `.env`。

| 边界 | 只读结论与具体路径 |
| --- | --- |
| 道路、发现账输入 | `autonomous_brain/run.py:228` 只取受限 bridge 的 odometry/local_road/holding/observe；`road_evidence.py:54,83,173,340` 使用公开 frame、里程计、局部出口、动作及观测引用生成节点/连接，未引用地图真值。`perception.py:334,347` 仅累积未入 WM 的红框 identity_ambiguity，保留原 bbox、frame/index、候选身份及理由；`run.py:244,419,422` 写 snapshot/summary，不回读独立 evaluator。 |
| R1 失败消费者 | `actions.py:203,275,319,349` 核验实际运动、落 motion 证据、异常后仅只读复看且不重发；新鲜 holding=False 保留 RELEASED_UNVERIFIED 或 pending 义务。`actions.py:2072` 为未归类异常附 action_evidence；`run.py:375` 写 round 后退出，finally 写 summary/关日志。现有定向测试覆盖 release/grab 已执行但回执丢失、持球掉落及传感缺字段。 |
| 已知数量兼容 | `task.py:130` 的 known 分支只增加明确数量门；新 discovery、退休未确认发现、当前红球歧义与 exploration 门均在 unknown 分支。公共抓放/唯一身份/夹爪证据门仍对两者生效。`actions.py:2048` 与 `run.py:276` 均传真实 task_spec。 |
| 敏感配置 | `bridge.py:61` token 仅进认证头；driver `:591` 返回脱敏能力配置；`llm.py:342,515,561` 通常不记录 key/base URL/认证头，并按类型记录传输异常。但下述 Request 构造异常位于受控捕获之外，因此不能声称所有异常日志都无敏感配置。 |

## 已复现的阻断项

调用链：`run.main` → `LLMClient.validate_formal_configuration`（仅模型/采样配置，通过）→ `decide` → `_call` → `llm.py:511` 在 try 外构造 `urllib.request.Request` → `ValueError` 含原 `LLM_BASE_URL` → `run.py:379` 的 `rounds.jsonl` result.reason 与 `run.py:403` 的 `summary.json` reason 原样落盘。

反例使用无 scheme 的 `boundary-synthetic-endpoint-secret`；真实 `LLMClient` 和 `run.main`，仅 Runtime/依赖查询替换为离线夹具，网络入口被禁止。结果：网络/模型/机器人调用均为 **0**，rounds 与 summary 均出现该合成 endpoint；合成 API key 未出现。此结论针对错误配置的异常处理，**不说明当前合法的实际配置或既有正式证据已发生泄露**；本审查未读取或重新验证实际配置。当前合法配置的预检与此错误输入分支未被安全覆盖是两项不同事实。

证据（均 create-only）：

- `raw/boundary-review/reproduce_invalid_endpoint.py`：精简复现脚本，拒绝覆盖既有证据目录；脚本头说明从仓库根目录运行。
- `raw/boundary-review/invalid-endpoint-result.json`：完整命令、结论、8 个被审源码 SHA256。
- `raw/boundary-review/synthetic-run/{rounds.jsonl,summary.json}`：真实失败日志消费者的输出，明确为合成离线证据。
- `raw/boundary-review/existing-boundary-tests.txt`：97 项既有离线测试的命令与结果。这些通过项没有覆盖上述反例。

## 仍存在的限制

历史 `raw/stage2-adversarial/review-summary.json` 中“persistent 未实现”仅描述当时迭代，现已由 `raw/stage2-discovery/implementation-summary.json` 及持久 discovery 实现替代，旧记录未改写。当前空帧、全部候选已交付或单个旧球重现均不能抹去两框/一身份的历史矛盾；**仍无通用 resolver**，证据不足会持续 pending，允许阶段 2 FAIL。道路与发现账的公共来源不等于拓扑正确或真值任务完成，仍须独立评测；本次未做正式验收。阻断项已交主任务，按停止决定不补源码。
