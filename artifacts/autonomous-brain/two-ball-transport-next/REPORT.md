# 双球运输修复：两局真实 FAIL，已停止

**双球没有跑通。** 两局都在 r32 模型决策期间因驱动 CDP 监控连接中断而被 SIGTERM 停止，尚未抓球；不是旧 HTTP 402，也不能将 r31 的身份竞争拒绝认定为不可恢复终因。第二局一次重连原页面后取得完整 record、samples、sensor-audit、captures、envelope；原页面仍 `running=true / healthy=true / errors=[]`。底层 CDP 异常原因 **UNKNOWN**。两次一球 PASS、旧双球 FAIL 及缺失原件事实均保留，不再开第三局。

**生产修改。** [`6e09544fa23d5b2546eb64743a4f4a372f3f1520`](https://github.com/54dK3n/wm_bench/commit/6e09544fa23d5b2546eb64743a4f4a372f3f1520)：`RoadMemory.remember_passage_failure / route_to / edge_passage_blocked` 保存失败当帧的出发/停止观测、方向、夹持、净空和命令引用；`Actions.move` 在实际平移前消费约束，普通 `_go_to` 绑定实际选中段，`NavigationProgress.remember` 保留失败义务。换帧、3cm/5°变化或无关图增长不解锁；可比较停点的新净空证据才解除对应条件。历史道路不删除，反向和不同夹持条件分别处理。当前观测到的其他出口交回模型选择，目的地连通性保持 UNKNOWN。驱动独立保存脱敏 stderr/CDP/控制器事件及服务端 trace，小型 envelope 有独立预算。

[`ae35f9c8e8f0a6f34cce49d0b6fd91b2f905b4d9`](https://github.com/54dK3n/wm_bench/commit/ae35f9c8e8f0a6f34cce49d0b6fd91b2f905b4d9) 只针对首局导出全盲增加 `reconnectForExport`：脑已停止后，最多一次/15秒重连原 endpoint、原页面读取状态并导出，不续脑、不创建新任务、不重发运动。v11/v12 显式沿用原严格评测要求，未降低双球门槛。

| 同局指标 | run-20260930T123109（6e09544） | run-20260930T130225（ae35f9c） |
|---|---:|---:|
| 真实模型 started / 完整回复；dispatch / judge | 32 / 31；31 / 31 | 32 / 31；31 / 31 |
| 观测 / 桥请求 / 运动；仿真秒 | 124 / 558 / 61；110.46 | 124 / 558 / 61；110.46 |
| 高层 pick / 实际 grab / 成功抓持 / release | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| 脑端 DELIVERED / 模型 done / 白名单外请求 | 0 / 0 / 0 | 0 / 0 / 0 |
| 独立合格物理交付 / 终态夹爪 | UNKNOWN / 公开观测空 | 0 / 物理和公开观测空 |
| driver / 双球 evaluator 退出码；结果 | 1 / 1；FAIL | 1 / 1；FAIL |
| 服务端 trace / 物理导出 | 1674 条完整 / 缺失 | 1674 条完整 / 五项完整 |

第二局平台 run ID `run-aff126e3-6c23-492b-8beb-3738fa2b2dbe`，Executor run ID `c8aa7f4cd98149569e72e49d0f18ac9f`，终止 step `:32`；第一局平台 run ID UNKNOWN，Executor `aa458c2a1eff456b957a2e1870c77f4a`。两局第32次请求 started 后未完成；严格转录检查均 FAIL，不能只因31条完整响应一致就改成 PASS。第二局源码前后及实际依赖检查 verified。

**实测边界。** 两局 r7/r17 空载受阻保存限制，r8/r18 模型选择提供的其他观测出口继续；原始引用见 `raw/checks/*-transport-index.json`。持球运输、普通 go_to 的实际重复段拒绝/绑定、首球释放、交付后第二目标采样均 **NOT_EXERCISED**，不能声称原 r59/r62 运输失败已实测消除。旧局四次阻塞的公共观测复算见 `raw/checks/transport-before.json`。第二局 `driver-diagnostics.jsonl` L71–77 记录 TypeError（无 message/code/cause）、1006断连、脑退出、重连健康原页面、随后正常 stop 关闭控制器；不把正常关闭倒因为平台崩溃。

**冻结配置。** 官方 `https://api.deepseek.com/v1`，`deepseek-flash / temperature=0 / thinking=disabled`；平台 `54b36f82109836226cf654e9a676ddf0c3b07cd0`，框架无关 `octos_robots.Executor` `33af31baefc9b3beaa855f33849d52254aaa8c4b` / `max_retries=0`；同一 Runtime/WM 贯穿每局。实际 vendored WM 树 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`，逐文件哈希在各局 manifest；不称 vendor 未修改。原传感/执行白名单、确认抓放门和200轮/1200秒不变；真值仅独立评测使用。

**针对性检查。** 运输相关97 PASS；driver最终27 PASS（含真实Chrome断CDP、受控后端夹具导出，非比赛成绩）；源码/依赖证明54 PASS。范围、实际命令和最初红测输出保存在 `raw/checks/COMMANDS.txt` 及相邻原 stdout；不累计重叠测试。没有扩张架构、升级依赖或开发第二目标新窗口。

实际两次入口如下（这些目录已存在，禁止覆盖；两条命令分别运行，不用 `&&` 跳过失败评测）：

```sh
# 分别运行过 STAMP=20260930T123109 与 STAMP=20260930T130225
OUT="artifacts/autonomous-brain/two-ball-transport-next/run-$STAMP"
node tools/autonomous_brain_driver.js --maps map-05 --runs 1 --platform-root workspaces/guangyang-platform/projects/car-python --orchestrator-root workspaces/octos_robots --task '把两个红球送到绿色存放区' --out "$OUT"
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 python3 tools/evaluate_autonomous_brain.py --input "$OUT/map-05-run-1" --out "$OUT-evaluation"
```

**原件、恢复、复算。** [本轮 Release](https://github.com/54dK3n/wm_bench/releases/tag/two-ball-transport-20260930-ae35f9c)；发布状态和压缩包 SHA256 见 `DELIVERY.json`。Git 只留本摘要、指标、必要脚本与校验；原日志和完整物理导出在证据包。下载附件到新空目录后：

```sh
shasum -a 256 -c wm-bench-two-ball-transport-20260930-evidence.tar.gz.sha256
mkdir evidence && tar -xzf wm-bench-two-ball-transport-20260930-evidence.tar.gz -C evidence
(cd evidence && shasum -a 256 -c artifacts/autonomous-brain/two-ball-transport-next/SHA256SUMS)
R=evidence/artifacts/autonomous-brain/two-ball-transport-next
python3 "$R/scripts/summarize_run.py" --run-dir "$R/run-20260930T130225/map-05-run-1" --out public-recount.json
python3 "$R/scripts/summarize_transport.py" --brain "$R/run-20260930T130225/map-05-run-1/brain" --out transport-recount.json
```

重新评测须使用对应冻结提交和上述依赖，在另一新输出目录执行原双球 evaluator；不回退工作区、不重跑仿真补成绩。第一局缺失原件仍缺失，第二局完整导出不补写第一局。阶段2、十布局、真机均未启动。
