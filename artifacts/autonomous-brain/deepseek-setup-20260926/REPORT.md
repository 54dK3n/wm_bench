# DeepSeek 配置与视觉实测 v1

用户要求改用DeepSeek并选择支持视觉的模型。本机已配置 `https://api.deepseek.com/v1`、`deepseek-flash`、温度0、`thinking=disabled`。账号模型列表确认可用；密钥保存在Git忽略的 `.env.local`，文件权限0600，未进入日志或提交。

官方依据：[图片输入](https://api-docs.deepseek.com/guides/vision/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON模式](https://api-docs.deepseek.com/guides/json_mode/)。本文记录的是2026-09-26实际验证结果。

| 验证 | 结果 | 调用耗时 |
| --- | --- | --- |
| 合成图片中的四个色块 | 4/4颜色与位置正确，实际响应模型deepseek-flash | 0.988695125秒 |
| 现有大脑客户端，完全虚构的空物体状态 | 一次返回合法 `explore({})`，未执行机器人动作 | 0.808198167秒 |

共2次Chat Completions，另有1次只读模型列表请求。全部使用温度0、关闭思考、JSON输出和流式传输；完整请求与响应在本目录，认证头不记录。测试时客户端为LLM v13，源码SHA256见 `setup-checks.json`。

`vision-fixture.png` 是现场生成的非敏感色彩图，问题没有提示答案。`synthetic-state.json` 全部为虚构值，不读取任何历史机器人状态。自动审批曾拒绝发送历史状态的原计划，该计划没有执行；修改为合成数据后测试通过。

模型支持图片输入，并不表示机器人已接入图片直传。当前生产大脑仍按用户既定流程把传感器检测喂给WorldModel，向模型发送状态JSON。本验证不代表map-05成功，也不改变已有FAIL记录或完成门槛。

文件版本与SHA256清单：`setup-checks.json`。报告及证据路径均相对于仓库：`artifacts/autonomous-brain/deepseek-setup-20260926/`。
