# v14 finish_reason 独立审查

本目录保存待审代码及旧 HEAD 的源码快照、纯内存反例脚本和实际运行结果。未读取 `.env` 文件或任何真实凭据；未调用网络；生产代码及其他 agent 的测试文件未修改。

复算命令（从仓库根目录）：

```sh
python3 -B artifacts/autonomous-brain/deepseek-finish-review-20260926/review.py
```

`result.json` 的 baseline/candidate 字段记录版本、SHA256 和源码快照文件；`base_commit` 固定旧 HEAD。脚本复算使用这些快照，不依赖以后变更的生产文件。

检查包含：13 个明确 SSE 边界用例，加固定随机种子 44 生成的 3000 个旧/新兼容模式等价比较；8 个非流式 finish_reason 用例；16 个替换 urlopen 的纯内存 `_call` 用例；重试/诊断能力集合保留检查。

在这些检查中未发现异常 finish_reason 产生动作、旧解析语义改变、重试或诊断能力集合退化。严格流式解析要求唯一 stop 终止以及以空行完整结束的 DONE。无终止空行或只有单换行的 DONE 不完整；非 stop、缺失 stop、重复终止、终止后 choice 均不能通过动作校验；正常 usage 尾块允许。

范围限制：这是代码与纯内存审查，不是实际模型服务测试，也没有逐个重放所有 v1–v13 历史运行。live 接收循环读到首个完整 DONE 后停止，故解码器的“DONE 后数据拒绝”仅覆盖已经传给解码器的字节。异常完成可以触发既有的一次格式修复；只有之后正常完成且校验通过的修复响应才可能返回动作。
