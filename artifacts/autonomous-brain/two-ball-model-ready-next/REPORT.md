# 同环境模型连接检查：BLOCKED_MODEL_TRANSPORT；本轮比赛 NOT_RUN

**双球仍未跑通。本轮没有新比赛成绩。** 开始时本地/远端均为 `c8bd522377cb7e8d47dfebcfed30c639cf77855b`，工作区干净。保留 e54ad61 的运行中监控恢复及4cf908e的空响应拒绝；未改生产源码、依赖或环境。仅增加本轮诊断脚本、证据忽略规则和结果。历史两次一球PASS、旧双球FAIL、旧评测ERROR原件均保持。

**本次真实检查。** 复用 driver 的 `parseArgs → loadLocalLLMConfig → validateFormalLLMConfig`，按同样 cwd/env（仅原有 `PYTHONUNBUFFERED=1`）启动 `python3`。五项LLM配置来自既有 `.env.local`，未覆盖继承变量。实际解释器 `/Library/Developer/CommandLineTools/usr/bin/python3`，Python3.9.6、LibreSSL2.8.3，证书/主机名验证开启。urllib环境代理和有效系统代理均为空，目标不命中绕过规则，实际直连；没有修改系统或子进程代理。

仅 **1次无凭据 GET `https://api.deepseek.com/v1/models`**：`socket.create_connection`完成，随后TLS `wrap_socket`失败；错误链 `URLError → ConnectionResetError(errno54)`，HTTP状态不可取得、响应0字节，诊断exit1。没有请求重试、没有敏感响应输出。这将**本次GET**定位至套接字创建之后的TLS包装/握手阶段，重置来源 **UNKNOWN**。不能据此回推旧POST的确切失败阶段或请求正文是否发送/到达，不能推断欠费、平台故障或TLS库版本是原因。

| 检查层 | 本轮结果 |
|---|---|
| 套接字创建 / TLS握手 / HTTP响应 | 已完成 / 未完成 / 无 |
| 鉴权、实际响应模型、SSE `[DONE]`、finish_reason、动作解析 | NOT_RUN / 不可取得 |
| 真实模型POST请求 / 新比赛局 | 0 / 0 |
| driver / 双球evaluator退出码 | NOT_RUN / NOT_RUN（不虚构0或FAIL） |
| 平台/Executor run ID、dispatch/judge、桥/抓放/交付/done/夹爪 | 本轮无运行，不可取得 |
| 监控恢复、持球运输、第二球采样 | NOT_EXERCISED |

模型决策smoke未执行，正式双球入口未启动；没有动作执行、真值输入、模型替换、SSL关闭或依赖升级。当前证据没有支持一个可验证的局部环境修正，因此按要求停止，不消费比赛新局。

**实际入口**（输出目录已经存在，禁止覆盖；新的检查需另取目录）：
```sh
node artifacts/autonomous-brain/two-ball-model-ready-next/scripts/check_model.js network artifacts/autonomous-brain/two-ball-model-ready-next/raw/network-01
```
该入口仅在 `network` 有HTTP响应之后才可另行运行 `smoke`；smoke复用原 `LLMClient.decide`、正式提示词、stream=true与动作校验，读取旧失败局首轮公共state，零传输重试、最多一次既有格式修复，不执行返回动作。此条件本轮未满足，不称smoke已通过。未为此重跑监控/导航测试；脚本语法与同环境入口已检查。

**依赖/配置未变。** 预定官方 `deepseek-flash / temperature=0 / thinking=disabled / stream=true`。平台 `54b36f82109836226cf654e9a676ddf0c3b07cd0`；既有框架无关Executor `33af31baefc9b3beaa855f33849d52254aaa8c4b`，max_retries=0；实际vendored WM树 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`，逐文件与加载哈希见FROZEN_INPUTS。清单是依赖检查，不代表运行比赛。原200轮/1200秒、白名单及全部安全门保持。

**证据。** NETWORK_CHECK.json为脱敏结构化结果，METRICS.json区分诊断与NOT_RUN；SHA256SUMS记录原始诊断及脚本/依赖清单。原stdout/stderr和退出码保持字节不变，归档只包含本轮检查。恢复时先校验压缩包，再解压至空目录，在根执行 `shasum -a 256 -c artifacts/autonomous-brain/two-ball-model-ready-next/SHA256SUMS`。模型连通性恢复是下一直接条件；没有新的搬运结论。
