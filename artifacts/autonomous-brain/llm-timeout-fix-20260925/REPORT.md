# 模型请求等待时间修复

第二局第 8 次模型请求超时，整局按 FAIL 保留。客户端 v5 的默认网络等待从 60 秒改为 180 秒，并在新记录 `transport_timeout_s` 写入实际值。模型、temperature=0.6、非思考设置、200轮/1200仿真秒上限均未变；网络错误仍立即停止，没有新增重试或隐藏模型调用。

`python3 -m pytest tests/test_brain_llm.py -q`：107 passed in 0.15s，退出码 0，由实现子任务执行并返回。真实第二局的 8 次 v4 调用（含最后的超时）用 v5 完整离线回放：8/8，除 mode 外逐条一致，网络与环境读取均为 0，见 `v4-error-replay/replay-checks.json`。这不是任务成功或全仿真复跑。

版本、命令和源码 SHA256 见 `validation.json` 与 `SHA256SUMS`。历史调用缺少新字段时，回放保持原记录格式，不补写。
