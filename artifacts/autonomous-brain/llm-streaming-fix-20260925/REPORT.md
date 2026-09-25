# Kimi 流式传输修复

第二局请求超时、第三局连接提前关闭，原局均保持 FAIL。第三局第一请求耗时超过 60 秒后成功，第二请求约 40.5 秒时断开；延长客户端等待时间不能保证解决所有连接关闭问题。

[Kimi 官方排查说明](https://platform.kimi.com/docs/guide/troubleshooting)建议使用流式输出减少非流式等待响应头时的连接错误。这提供了修复方向，但不能据此证明第三局究竟由服务端还是中间链路断开。

客户端 v6 默认请求 `stream=true`，逐行保存完整 SSE，再聚合 `delta.content` 并校验单个动作 JSON。模型、温度 0.6、非思考模式、180 秒等待和任务上限保持原样。网络错误仍停止；只有完整收到但不合法的模型输出允许一次修复请求。

按[官方 SSE 说明](https://platform.kimi.com/docs/guide/utilize-the-streaming-output-feature-of-kimi-api)，必须收到 `[DONE]` 才算传输完整。缺失结束标记或连接中断时保存已收到的内容并失败，不能把部分 JSON 当作动作执行。推理字段留在原始记录，不拼入动作正文；支持使用量统计尾块。

回放按原请求恢复流式或非流式格式；旧记录没有 `stream` 字段时不补写。检查结果、版本与 SHA256 见同目录 `validation.json` 和 `SHA256SUMS`；真实连接失败的旧记录核验见 `v5-error-replay/replay-checks.json`。传输检查不代表双球任务成功。
