# 阶段 2 · 第 2 轮交付汇总

**本轮 FAIL：10/10 局出现 program_error，全部发生在 tick 0 / 仿真 0 秒；双球送达 0/10。** 每局在首次 observe 后启动失败，没有进入目标选择、确认、抓取和送达。

原始自动汇总原样保存在 [AUTO_SUMMARY.md](AUTO_SUMMARY.md)。冻结门槛和分组机读字段保留在 [opt2_report.json](opt2_report.json)，本说明不重写它们。全部数字与原始索引见 [numeric_evidence.json](numeric_evidence.json)。

## 运行前检查与冻结

Python 离线测试 **386 passed**，Node 驱动测试 **19 passed / 0 failed**，pylint 指定错误检查 **0 报错**，预检 all_pass=true。这些检查未发现本次运行时启动缺陷，不能替代实际运行结果。

批后冻结核验 **97/97 文件未变**；本次另核对已封存源码副本 **97/97** 与冻结 SHA/字节数一致。这里指本轮执行期间和封存副本；后续开发目录中的修复不改变本轮历史。

版本 `wm-opt2-r2-20260924`；源文件 SHA256 `90191e8764de3b98cd4251341f582a60e4b097e98453273bf5b5ab2eefe0a029`；平台 trim 后执行 SHA256 `d423f74fc968b1921d9f9dba6e644ae416880ae3addf00500081d886e938b28f`。WM commit `326a5f8892b9da11996b5f3d3d0fc56341aca6e4`，嵌入包 SHA256 `61308c1c20270ec31d8ee5870ed2b01bf6920075e4820e5fc8c30bd2e626f1fb`。

## 逐布局原始结果

下表的错误原文来自 full record 的 program_error；每局事件索引均为 1、seq=11、t=0 ms，随后 run_finished.reason=program_error。这里的“0 秒”是仿真尚未推进，不代表完成得快。

| 布局 | 错误原文 | 错误 tick / 仿真 s | observe / 原生 PNG | PNG bytes | 抓取尝试 / 送达 | 驱动墙钟 s |
|---|---|---:|---:|---:|---:|---:|
| map-01 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 215503 | 0 / 0 | 6.085 |
| map-02 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 214534 | 0 / 0 | 6.364 |
| map-03 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 218186 | 0 / 0 | 6.356 |
| map-04 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 217949 | 0 / 0 | 5.987 |
| map-05 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 231513 | 0 / 0 | 6.162 |
| map-06 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 215685 | 0 / 0 | 6.203 |
| map-07 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 228247 | 0 / 0 | 6.028 |
| map-08 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 231503 | 0 / 0 | 6.146 |
| map-09 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 218085 | 0 / 0 | 6.276 |
| map-10 | 第 3761 行用了不存在的名称。小车请使用 robot.forward()、robot.right_angle() 等常用指令。 | 0 / 0 | 1 / 1 | 227810 | 0 / 0 | 6.275 |

报错所指封存程序第 3761 行为 `run_target_flow()`。该平台提示只提供顶层行号及“名称不存在”，不能据此直接把缺失名称认定为 `run_target_flow`；具体启动根因由独立修复分析确认。

共 10 次 observe、10 张原生 PNG、2,219,015 字节图像、20 条 native samples。每局仅启动第一球，第二球未开始；没有确认轨迹或实际抓取，真值前/侧向、抓取视线夹角、确认后行驶距离及 WM 误差均为 **unknown / 未发生**，不能填写为 0。E/G 没有有效确认样本，本轮没有可报告的泛化精度。

## 证据完整性与结果边界

证据终检 **10/10 通过**：完整 record、samples、query/frame/PNG 原始字节与精确 render truth 绑定、原始程序 SHA 均通过冻结审计，审计所引用文件本次逐项复查未变；hostIO 的 terminal.finalVerification 与 finalNativeVerification 均为 true，终端磁盘字节数和 SHA 另行重算一致。没有抓取/送达成功事件，因此成功关键帧需求和实际张数均为 0。证据齐全记录的是失败过程，不使任务通过。

驱动 timedOut=0/10、stallReason 非空=0/10。十局都是平台明确的 program_error 结束，不是墙钟期限或驱动停止造成。由于仅运行到 tick 0，本轮不能用来证明增量日志优化在长局中的性能收益，也不能验证道路提速或抓取角扫优化的实战效果。

冻结分组算法保留了 10 个 singleton 条目，但 **0/10 局有可分组的目标相关轨迹**。因此不能声称覆盖了 10 个独立目标场景；本轮暴露的是 **1 种共同启动失败类型**。实际目标场景成功比例不可估计（null）。机读 independent_success 字段原样保留，不据此调整门槛或重新分组。

P3 首选：已评估 0 局，匹配 0/10（未知不作匹配）；没有成功双球局，耗时中位数为 null，不能写为 0 秒。确认/道路/抓取相关的“未违规”门没有实际闭环执行覆盖。

## 上一轮成功回归

| 布局 | 上一轮双球结果 / 仿真 s | 本轮结果 | 回归 |
|---|---|---|---|
| map-05 | 成功 / 313.7 | tick 0 program_error，双球失败 | 是 |
| map-10 | 成功 / 327.4 | tick 0 program_error，双球失败 | 是 |

上一轮 2 条双球成功回归均失败；没有豁免或从分母中排除这些启动错误。原始门仍为 FAIL。

复算本文件和所有数字（不运行仿真、不调用旧轮报告生成器）：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-2/summarize_numbers.py
```
