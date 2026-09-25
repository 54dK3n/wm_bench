# Kimi 相同失败请求的独立恢复复测

这是模型连接诊断，不是正式仿真、续跑或任务成功。原Run16的FAIL和完整日志不变。

原始输入来自`artifacts/autonomous-brain/map05-run-16/map-05-run-1/brain/llm.jsonl`第22次调用，即第20轮初始决策的最后一次网络重试。该轮三次请求均返回HTTP502，未生成动作。诊断随后逐字复用其request对象，未更换模型、温度、消息、JSON格式或流式选项，只发出一次模型请求，没有调用机器人。

| 字段 | 本次诊断结果 |
|---|---|
| 模型请求数 / 机器人调用数 | 1 / 0 |
| elapsed_s | 9.245356458秒 |
| 请求内容SHA256 | `e2a52f511c2226a7611d6ad004cea9fbcaee36a69f007dfb644ce31e41d37555` |
| 与原请求相同 / 诊断前后源码相同 | True / True |
| 响应校验 | 合法单动作JSON，validation_error为空 |
| 返回动作 | go_to(target_021)，仅记录，未执行 |

同一请求在后续复测成功，证明这份输入不是必然失败的请求。它不能单独定位502的底层原因，也不保证增加重试就能完成任务。既往请求字节长度与失败区间有重叠，没有据此认定上下文过长或调整模型参数。原Run16日志中的失败响应为Tengine的502页，该信息不足以定位具体上游组件。

[Kimi K2.6官方参数说明](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)支持非思考模式及温度0.6；[官方JSON Mode说明](https://platform.kimi.com/docs/guide/use-json-mode-feature-of-kimi-api)支持当前json_object请求方式。配置与这些说明一致。[官方断线重连示例](https://platform.kimi.com/docs/guide/auto-reconnect)允许按应用设置有限重试及条件；本项目具体次数仍是实现选择，不是动作或任务成功门限。

完整请求、原始SSE、模型名、输出、校验与耗时保存在`request-01/llm.jsonl`，其SHA256为`f830a5c405f2db8d28c8c898c38228a6c5797fc2c76852e271c9ad25bcae1c16`。`request-01/summary.json`保存原输入文件SHA、调用对应关系和全部脑源码前后SHA。诊断脚本版本为`kimi-failed-request-probe/v1`，SHA256为`be861b062dde2021f90cc424d9b12c3d9979570e521558645ff5bdbe7224c2aa`；脚本固定单次调用且输出目录必须不存在，不执行机器人动作，也不写回旧运行目录。它读取本地忽略配置以调用已授权的官方接口，凭据不进入日志。
