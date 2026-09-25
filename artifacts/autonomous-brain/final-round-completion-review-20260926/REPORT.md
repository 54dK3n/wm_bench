# 最后一轮完成状态：只读诊断

当前 runtime v9 有一个确定的终止顺序边界：成功的 `done` 如果恰好发生在最后允许的一轮，会被记录为 `failed / round_limit`。这是离线控制流程缺陷复现，**不是 Run15/16 的终止原因，也没有证据表明 Run17 会触发**。

`autonomous_brain/run.py:294–299` 先判断轮数上限并退出，随后才判断 `done` 成功：

```python
if number >= config.get("max_rounds", 200):
    reason = "round_limit"
    break
if action["action"] == "done" and result["success"]:
    status, reason = "done", "observation_completion"
    break
```

因此已经记录到本轮日志的 `result.success=True` 不会在该边界转化为成功的 summary 状态。后续若修复，只需先认可已通过原门槛的 `done`，再检查轮数退出；本次没有应用修复，也没有改动任何门槛。

复现使用纯内存 Runtime/模型替身，提供空爪、无待处理红球、至少一个已观测节点且没有未探索出口的显式夹具。最后一轮执行真实 `Actions.execute(done)` / `Actions.done`，包含其新观测步骤。早期非终止轮仅用于推进计数，不执行真实动作。目录创建、日志写入、summary 写入均被替换为内存操作；网络入口禁止调用。没有启动机器人、仿真或真实模型，没有读取 Run17 日志、真值、布局或凭据。

运行命令：

```text
python3 -B artifacts/autonomous-brain/final-round-completion-review-20260926/reproduce_final_round.py
```

| 允许轮数 | 执行 done 的轮次 | 真实 done 门槛结果 | summary | runner 退出码 |
| ---: | ---: | --- | --- | ---: |
| 1 | 1 | 成功 | failed / round_limit | 1 |
| 2 | 1 | 成功 | done / observation_completion | 0 |
| 200 | 199 | 成功 | done / observation_completion | 0 |
| 200 | 200 | 成功 | failed / round_limit | 1 |

四项均复现预期控制流程，网络调用和机器人调用均为 0。诊断脚本退出码 **0** 表示“成功复现现有缺陷”，不表示任务通过。

- [独立复现脚本](reproduce_final_round.py)
- [原始执行输出](reproduction-v1.stdout.txt)
- [执行命令、退出码、提交及执行前后 SHA256](execution-v1.json)

当前 `autonomous_brain/run.py`：runtime v9，SHA256 `87b54b52f589d0f8c8824fe0ecbe0570815fd869a69cd0269feff6f63c188039`。已核对该文件与 Run17 冻结提交 `33b16ca` 对应文件完全一致。所记录的脑源码、driver 和 evaluator 执行前后 SHA256 相同。本次只新增本诊断目录，没有更改默认测试、正式源码、配置或历史报告。

此前已结束 Run15 在第69轮因 URLError 重试耗尽停止，Run16 在第20轮因 HTTP502 重试耗尽停止；两局都没有执行 `done`，因此本边界不解释它们的失败。此诊断仅供 Run17 结束后评估修复，不影响当前运行或其验收结论。
