# LLM v13：有向行程提示与 v12 兼容

生产变更仅为 `autonomous_brain/llm.py`、现有 `tests/test_brain_llm.py` 的版本断言和新增 `tests/test_brain_llm_frontier.py`。未改导航、动作、runtime、动作验证门槛、采样温度、JSON 修复次数或重试次数。未提交 Git。

提示新增 exploration_hints：当前 fresh 未探索出口优先；当前出口均完成时可参考实际完成有向行程的首角；首角仍须原样属于当前 robot.exit_angles；每轮重新观测核对，空提示不等于 done，同桶/提示不证明物理身份相同。既有 U、pending、CONFIRMED 与完成规则仍保留，程序不会替模型选择建议或修改传入状态。

版本从 v12 升至 v13。三个显式能力集合同时列出 v12/v13：五次 transport retry 上限、每次调用必须提供 retry metadata、必须有 transport_diagnostics。它们不再因版本不等于“当前 VERSION”而错误降为 legacy。v1–v11 原有 0..2 上限与可选字段行为保留。回放恢复记录中的 prompt/request/state，绝不注入新提示或新状态字段。

## 冻结 SHA256

- llm.py：`6497acb290b543f6a6087e1861aaeb031de769987587dbecf9bdf6234cd51fce`
- test_brain_llm.py：`6367afe09e7938fc745fd1041f8d1ae926f864991e497a5528036e72a90bf1e2`
- test_brain_llm_frontier.py：`43529a7e67933199979e7aff8a1bc169fd7e94d896d45ad93315e988c8c803ac`
- test_brain_llm_recovery.py 未修改。

[修改前 hash](before-sha256.json)、[修改后 hash](after-sha256.json)、[冻结 v12 原源码](llm-v12-source.py.txt)。

## 验证

三个 focused LLM 测试文件共 **235 PASS**。新测试独立构造字面 v12 记录，未使用当前 VERSION 或新 live 日志冒充历史记录：limit 3/5、耗尽/恢复均逐字段除 mode 一致；v12/v13 第一和后续 call 缺 retry limit/index/delay 或 diagnostics 必须拒绝；字面 v11 limit 3/5 必须拒绝。回放封锁环境、网络和 sleep。提示测试验证字段原样传入、温度整数 0、模型可选另一个合法 fresh 出口且原状态不变。

- [测试命令/退出码](tests-command.json)
- [测试 stdout](tests.stdout.txt)、[stderr](tests.stderr.txt)

使用原工具 `tools/replay_brain_llm.py` 对已结束 Run20 原 saved state 严格离线回放，并在外层加 sleep 禁止钩子：**200/200 轮、216/216 calls PASS**；全部记录已消费；除 mode 外完整逐字段一致；原 rounds/llm/summary hash 未变；网络 0、环境读取 0、sleep 0。动作执行失败仍不误算 LLM 决策失败。未调用模型、未读凭据或 .env、未执行模拟/动作、未读取 truth/layout。

- [回放命令/退出码与 sleep 计数](replay-command.json)
- [回放 stdout](replay.stdout.txt)、[stderr](replay.stderr.txt)
- [完整核验](run20-replay/replay-checks.json)
- [逐调用回放](run20-replay/replayed-llm.jsonl)

此验证证明新提示下客户端仍兼容既有调用记录，不证明新的模型决策会收敛或真实任务已经成功。
