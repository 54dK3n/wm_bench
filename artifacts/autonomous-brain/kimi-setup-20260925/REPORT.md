# Kimi 本机配置与连通性

本机配置已完成，密钥鉴权和真实 JSON 输出验证通过。用户已明确允许改用 Kimi K2.6 非思考模式的固定温度 0.6；正式 map-05 已启动，运行结果另以该局评测为准。

配置保存于 `.env.local`，权限 `0600`，Git 已忽略且没有跟踪该文件。报告和日志不包含密钥，GitHub 只交付通用配置加载代码、无密钥示例和脱敏结果。driver v4 自动加载本机配置，已有环境变量优先，回放跳过本机配置。状态见 `configuration.json`。

已验证官方地址 `https://api.moonshot.cn/v1`。`GET /models` 返回 HTTP 200，当前列出 `kimi-k2.6`、`kimi-k2.7-code`、`kimi-k2.7-code-highspeed`、`kimi-k3`；完整响应见 `provider-models-cn.json`。本机选定 `kimi-k2.6`。

用实际客户端发送 JSON 动作连接测试，temperature 保持 0，未控制机器人。服务返回 HTTP 400：`invalid temperature: only 1 is allowed for this model`。完整输入、输出与耗时见 `temperature-zero-probe.jsonl`，结果见 `temperature-zero-result.json`。这是失败的真实 API 请求，不是模型成功输出或自主任务运行。

[官方模型参数说明](https://platform.kimi.com/docs/api/models-overview) 规定 K2.6 思考模式温度固定 1，非思考模式固定 0.6；当前其他列出模型固定为 1。用户随后明确确认允许 K2.6 非思考模式的 0.6。已写入本机配置，客户端默认值仍保留 0，只有显式配置才改变。

已增加显式配置 `LLM_TEMPERATURE`（默认 0）与可选 `LLM_THINKING`（未设则不传），不会按服务商错误自动更改。回放从原始请求恢复这些参数，继续逐请求检查；旧记录和旧验收报告保持不变。获准参数的实际请求已返回合法 `look_around` JSON，一次调用成功，输入、响应和耗时见 `approved-parameter-probe.jsonl` 与 `approved-parameter-result.json`。这一步没有执行机器人动作；随后已启动正式运行 `artifacts/autonomous-brain/map05-run-01`。

本次检查命令与输出见 `validation.json`，版本和 SHA256 见 `SHA256SUMS`。旧总报告描述其提交时的状态；本次已解除密钥缺失和参数冲突；正式 map-05 双球是否成功仍须由该局独立评测决定。
