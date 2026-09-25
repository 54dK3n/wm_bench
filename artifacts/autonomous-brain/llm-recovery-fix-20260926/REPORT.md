# 有限网络恢复修复（离线验证）

正式运行设置为最多 5 次网络重试，即同一 JSON 请求最多 6 次底层调用，延时沿原公式为 1、2、4、8、16 秒。客户端默认仍为 0。原瞬态错误白名单不变；400/401/403 等永久 HTTP 错误立即停止。非法动作 JSON 仍最多修复一次，若初次请求和唯一修复都在第 6 次才取得仍不合法的输出，单轮最多 12 次底层调用。模型、温度、thinking、180 秒传输超时、完整 SSE / [DONE] 校验及机器人判据均未改变。

生产修改仅 `autonomous_brain/llm.py`（v11→v12）及 `autonomous_brain/run.py`（v8→v9）。没有更改动作、导航、平台、driver、evaluator、Judge、轮数或仿真时间上限。没有发起真实 API 或仿真。

新 live v12 记录 `transport_diagnostics`：`phase` 为 open/read_stream/read_body，`received_bytes` 是已捕获字节（含 IncompleteRead.partial），不是底层套接字所有已收字节。HTTP 状态失败的主失败阶段为 open，即使错误正文随后读取成功；正文读取失败则为 read_body。非 HTTP URLError 只另存 reason 对象的类型名和严格整数 errno，不记录其文本、URL、header 或 key。旧 response_body 原始证据保留规则不变。

旧 v1–v11 回放恢复原提示、请求、stream 缺省和重试上限 0–2；不会补写诊断字段。v12 回放恢复上限 0–5、保留并校验诊断字段结构。所有回放继续按逐次请求哈希、序号、attempt、重试索引/延时以及输出一致性校验，禁止联网和等待。

验证：

- [修改前定向回归](baseline-tests-v1.txt)：181 passed in 0.23s，exit 0。
- [最终定向回归](targeted-tests-v2.txt)：225 passed in 0.35s，exit 0；[完整命令](targeted-tests-v2.json)。包括六次耗尽、第4/5/6次恢复、永久错误、最多一次 JSON repair、v1–v11 回放、v12六条回放、诊断隐私/结构/字节数，以及正式 runtime 显式上限5。
- [真实 Run15 v11 离线核验](run15-v11-replay/replay-checks.json)：69/69轮、84/84调用，除 mode 外全记录一致且耗尽；网络调用0、环境访问0。原末轮三次网络失败后停止仍一致。这只验证历史模型记录回放，不执行机器人动作、不宣称全任务成功。[原始命令及stdout](real-legacy-replay-v1.txt)。
- root独立运行[全部brain回归](integrated-tests-v1.txt)：611 passed in 0.78s、exit 0；[测试前后源码哈希一致](integrated-tests-v1.json)。
- root独立[历史真实版本矩阵](legacy-matrix-v1/matrix.json)：v3至v11各选一局，共294轮、327条调用，全部严格匹配，网络/环境读取均为0。每局checks保留逐轮结果及输入SHA；临时生成的重复回放全文已删除，原始已归档记录保留。[可复算脚本](run_legacy_matrix.py)版本为brain-legacy-compatibility-matrix/v1，脚本SHA见matrix.json；v1/v2的结构兼容由上述定向用例覆盖。
- [修改前源哈希](source-before.json)、[修改后源及测试哈希](source-after.json)、[diff检查](diff-check-v1.txt)。除两个授权生产文件外，记录的其余脑/driver/evaluator源哈希均未改变。

最终生产 SHA256：

| 文件 | 版本 | SHA256 |
| --- | --- | --- |
| autonomous_brain/llm.py | v12 | `cd4ac7b3f3534cb53c73388205c3a750b73bd175725ddc26411bc39b369defab` |
| autonomous_brain/run.py | v9 | `87b54b52f589d0f8c8824fe0ecbe0570815fd869a69cd0269feff6f63c188039` |

当前证据没有验证新的真实模型运行能否完成任务。有限网络重试是为应对已记录服务中断选择的实现策略，独立于用户原有“非法 JSON 只修复一次”的限制；本目录不改写已结束运行的失败结论。[同一失败请求的后续真实复测](../kimi-recovery-check-20260926/REPORT.md)已单独保存，只证明当时该请求恢复成功，不保证本修复或任务成功。
