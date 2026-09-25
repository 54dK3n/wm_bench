# 离线模型调用重放

重放核验：PASS；40/40 轮，40/40 条调用记录。网络调用 0 次，环境读取尝试 0 次。

使用原 rounds.jsonl 的状态重新验证 llm.jsonl 中的模型输出；除 mode 外完整记录必须一致，且记录必须全部耗尽。已有 action 时，随后发生的动作执行失败不会误计为模型决策失败。

这仅验证离线模型记录重放，不执行动作、不重放全仿真，也不代表任务成功。原运行状态为 failed，原因：BridgeError: odometry: NOT_RUNNING。原运行结论和证据没有被改写。

详细比对和源文件 SHA256 见 replay-checks.json；完整回放记录见 replayed-llm.jsonl。
