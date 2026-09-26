# 模型正常结束校验 v14

LLM客户端从v13升级到v14，源码SHA256：`92e1f2bc9f1545d9270186656b6ba0bed7269fa50436ef9a2f70536fbe6575be`。

新调用只有正常 `finish_reason=stop` 才允许生成动作；流式响应还须完整空行分隔的 `[DONE]`。即使已收到完整动作JSON，length、aborted、insufficient_system_resource、缺失或重复结束等响应也不能执行。异常完整响应沿用原有一次修复机会，修复请求自身必须正常完成；流中断沿用原有限网络重试。非流式响应同样要求stop。原始响应完整保留，判定规则没有放宽。

live读取到首个完整DONE即停止，后续未读取的网络字节不在校验范围；已捕获正文中的重复终止和后续choice会被拒绝。历史v1–v13按各自原版本语义回放，提示词、动作判据和旧记录均不改写。

- 首次沙箱测试858通过，3个本地HTTP测试因不能绑定loopback端口失败，原结果见 `integrated-tests.txt`。
- 获准本地端口权限后，全部861项通过，见 `integrated-tests-local.txt`；完整命令和测试前后SHA256见同名JSON，源码与测试未发生变化。
- Run21 v13真实日志181轮、190次调用严格离线回放通过；除mode外逐条相同，网络/环境访问为0，原日志未修改。证据见 `run21-v13-replay/replay-checks.json`。

模型配置和真实图片能力证据另见 `artifacts/autonomous-brain/deepseek-setup-20260926/REPORT.md`。该修复及离线检查本身不代表map-05任务成功。
