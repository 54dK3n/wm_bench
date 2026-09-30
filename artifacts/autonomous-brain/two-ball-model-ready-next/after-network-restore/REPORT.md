# 模型连接恢复后两次真实双球：均 FAIL，已停止

**map-05 双球没有跑通。** 同运行环境的官方 HTTPS 与真实流式模型 smoke 已通过；随后运行一局基线，针对其实际阻塞做一次小修，再运行一局验证。两局独立评测均为完整 FAIL，不能相加。历史两次一球 PASS、旧 FAIL/ERROR、旧连接阻断报告和原始字节全部保留。

**连接与调用链。** 沿 driver 原配置加载器、同一 `/Library/Developer/CommandLineTools/usr/bin/python3`（3.9.6 / LibreSSL2.8.3）及继承环境：1次无凭据 GET `/v1/models` 得到401；随后既有 LLMClient 的1次真实 POST 得到 deepseek-flash、SSE `[DONE]`、finish_reason=stop 和合法动作，未执行。用户指出此前使用UQ VPN；继续后的检查恢复，但未做VPN对照实验，不回写旧重置根因。代理/证书/模型配置未由代理修改。正式链路仍为 Runtime.observe / 同一 WM → 既有 `orchestrator.executor.Executor.run_next` → LLMClient → run_step → Actions → 新观测/Judge；max_retries=0，原200轮/1200秒及安全门不变。

| 独立运行 | 基线 `run-20260930T214331` | 小修验证 `run-20260930T221441` |
|---|---:|---:|
| 冻结源码 | `3aaa2f3509d9c5ebb0725d9ef40324f813886af8` | `75fe35955269f5a1afc4f4da7cd5d349a9977a41` |
| 真实POST / 合法决策 / dispatch / judge | 203 / 200 / 200 / 200 | 203 / 200 / 200 / 200 |
| 观测 / 桥请求 | 917 / 4186 | 954 / 4371 |
| 高层pick / 物理grab / 观测成功抓持 / release | 2 / 4 / 1 / 1 | 2 / 4 / 1 / 0 |
| 脑端DELIVERED / 物理合格交付 / 独立完整交付链 | 1 / 1 / 1 | 0 / 0 / 0 |
| 模型done / 最终夹爪 | 0 / 空 | 0 / 持球 |
| 仿真秒 / 停止 | 988.54 / round_limit | 1181.66 / round_limit |
| driver / evaluator退出码；双球结果 | 1 / 1；FAIL | 1 / 1；FAIL |

每局203 started/203 finished，3次格式不合格回复后使用原有格式修复，0传输错误；加独立smoke共407次真实模型POST。两局白名单外请求、执行异常及外部停止均0；五类原始物理数据全部导出，服务端trace已保存，source_proof均verified。评测保留的通用 `execution_or_controller_error` 来自非零进程退出分类；controllerErrors为空，不能解释成控制器实际故障。严格转录回放各200轮/203调用通过，仅说明转录一致，不证明全部导航物理正确。

**基线进展与最小修复。** 两局r37均由 `brain-000679`（obs150→151）成功抓持，obs151–156连续持物，obs157序列化HELD；之前失败grab全部保留。基线r139 `brain-003335`（obs722→723）释放，obs724/t43524提供独立视觉见证，obs725序列化DELIVERED，独立物理与完整链均通过1球。随后r166 `brain-003906` 走40.6cm至obs848；r167–200对同一已知堵塞前向请求明确未发送，却绕过原有归路入口，零运动重复失败。小修仅在 `Actions.explore / return_after_known_road_rejection / return_from_blocked_road` 和 `RoadMemory.observed_road_return_support` 接回原有有界恢复：核验真实来路、精确端点、持物、新观测、逆向限制和实测里程；未知执行不重发，无证明则拒绝；归路仍不算任务成功。

**验证局的第一个持续运输阻塞。** r55 `brain-001088`（obs239→240）持球前方净空停止；r56起节点身份变为未解决，r57实际安全替代移动仍不能确认历史节点。r58有向拒绝生效；r61来自不同入口，不笼统算作同方向重试。后续出现真实往返和 `junction_identity_unresolved` / `known_route_exhausted_needs_exploration`，没有到达存放区或释放。公共证据显示净空停止打断道路连续证据后，重访未重新建立确认节点；尚不能断言这是路线耗尽的唯一根因。终态obs954/t59083仍持球，无pending_grasp。已用完一次小修复测，停止，不再补代码或跑第三局。

**验证范围。** 新红例先1 failed；修复后针对性22 passed。相关组137 passed / 4 failed，四项在原3aaa代码同样复现（34 passed / 4 failed），是旧断言不允许现有阻塞记录，未放宽断言。原公共obs847–850只读查询产生有效40.6cm返回依据；不等于平台恢复成功。命令及原输出索引见METRICS和归档 `raw/checks/test-command-summary.json`。两局运行中监控恢复均 NOT_EXERCISED；新增预拒绝归路在验证局 NOT_EXERCISED；验证局第二球采样 NOT_EXERCISED，未提前实现新窗口。

**冻结与取证。** 平台 `54b36f82109836226cf654e9a676ddf0c3b07cd0`；Executor `33af31baefc9b3beaa855f33849d52254aaa8c4b`；实际WM树 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`。两局逐文件/加载哈希一致，模型保持官方 deepseek-flash / 0 / disabled / stream=true。平台run ID分别 `run-ca4d9c80-d504-462e-ad31-325fa3ffc44a`、`run-26dcace2-b7fb-4c47-a93b-30f59ce5f743`；Executor ID分别 `5e742c5d7c31463c9faa8076c72f8723`、`4f64d4e3afb24aea9d451726d7fa7614`。

[指标与引用](METRICS.json) · [实际逐文件冻结](FROZEN_INPUTS.json) · [命令、恢复与复算](RESTORE.md) · [原始证据Release](https://github.com/54dK3n/wm_bench/releases/tag/two-ball-model-ready-20260930-75fe359)。原数据仅在附件，Git不含完整日志/record，不修改旧报告。未启动阶段2、十布局或真机。
