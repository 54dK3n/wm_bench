# 假模型记录离线回放诊断

这不是任务验收，也不代表真实大模型调用已验证。

结果：PASS。使用 `diagnostic-stub` 原始状态与调用记录，按 explore、look_around、LLMOutputError 重放 3 轮；4 条调用记录全部耗尽。urllib 联网入口被禁止且调用次数为零。除 mode 从 live 变 replay 外，完整记录逐字段相同。

详细检查及源日志 SHA256 见 `replay-checks.json`；回放输入输出见 `replayed-llm.jsonl`。
