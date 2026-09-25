# map05-run-07 失败分析

正式结论：**FAIL**。首个红球已确认并抓住，但没有执行 place 或 release，也没有任何有效送达。r48 接近绿色区时在视觉停靠的前进动作后离路；r49–52 的 explore 均因当前不在道路上而拒绝执行。评估方随后请求正常停止并保留失败证据。本局没有达到 200 轮或 1200 仿真秒上限。

冻结源码提交是 `2e76b6f5de1789ba51d90f2ce5f9501e6307d64c`。driver 记录 `sourcesUnchanged=true`；7 个 brain 文件与 driver 共 8 个文件的运行前、运行后记录哈希均与该提交的 Git blob 字节一致；brain 自身汇总的 7 个源文件哈希也一致。`source-commit.json` 保存逐文件 SHA256 和比较结果。核验以冻结提交和运行记录为准，不把运行结束后的工作区修复混入本局。

## 正式指标与停止原因

| 指标 | 复算结果 |
|---|---:|
| 轮数 | 54 |
| 模型调用数，含传输重试 | 57 |
| 模型累计调用耗时 | 1211.691688041001 秒 |
| 仿真时间 | 249.92 秒 |
| 观测数 / motion 记录数 | 266 / 159 |
| 已抓住的任务红球 / grab 调用 | 1 / 2 |
| place / release / 有效交付 | 0 / 0 / 0 |
| 最终夹爪 | holding=true，target_023 |
| 记录为失败的动作 | 12 |
| 非白名单脑请求 | 0 |

54 轮动作为 explore 38 次、look_around 9 次、go_to 6 次、pick 1 次。模型累计耗时是请求等待时间，并非仿真用时；超过 1200 秒的模型等待累计值不等于达到 1200 仿真秒上限。数字由 `run-metrics.json` 的输入日志和 SHA256 复算，正式验收见 `report/evaluation.json` 与 `report/REPORT.md`。

模型调用 35（decision35）发生 URLError、42（decision41）发生 HTTP502、54（decision52）发生 URLError；随后调用36、43、55在同一决策中重试成功。57次调用对应54次模型决策，没有因模型传输问题终止本局。

`evaluator-stop.json` 记录评估停止请求时间 `2026-09-25T07:40:05.988Z`，记录时 tick12496。停止理由是已经观察到 r48 视觉停靠后离路，后续 explore 拒绝运动。r53 的四次90°转向完成后，最后观测时间为249.92秒；r54已经产生 look_around 动作，但首个 turn 收到 `NOT_RUNNING`，最终脑错误为 `BridgeError: turn: NOT_RUNNING`。driver 随后以 `status=complete` 完成导出。

这里的“正常停止”指评估方通过停止请求结束试验并完整导出，**不代表任务成功**。r54错误属于停止后的桥拒绝，不能被解释为模型请求失败或一次已经执行的导航运动失败。独立评测仍保留 `execution_or_controller_error` 失败项，以及未完成 observed_done、无交付事件、最终位置不满足存放区条件等正式失败项。

## 首球确认、接近与抓取时间线

离线像素对应将 WM轨迹 `target_023` 唯一绑定到首个任务红球。以下真值身份和原生事件仅用于停止后的评测，没有提供给在线脑。

| 证据 | 仿真时间 | 结果 |
|---|---:|---|
| r14 obs56，首次原始检测与 WM入库 | 44.22秒 | 首次看到 target_023 |
| r18 obs75 | 61.58秒 | CONFIRMED |
| r19 obs86 | 69.62秒 | go_to 成功，新鲜距离37.342494cm、方位0.594737° |
| r20 motion51，第一次grab后obs90 | 71.50秒 | holding=false |
| r20 motion52前进6cm后obs91 | 72.46秒 | holding=false |
| 原生 package_grabbed，tick3647 | 72.94秒 | 首次抓取事件 |
| r20 motion53，第二次grab后obs92 | 73.22秒 | 脑首次读到holding=true |
| r20 motion54后退30cm，obs93 | 76.42秒 | 原位置无匹配球，确认HELD |

确认后的下一轮 r19 即选择 go_to，同一目标在 r20 执行 pick。首次原生抓取事件、首次传感器持球、抓取后复查是不同时间，不能都写成76.42秒。此后至obs266一直持球，未释放。

第二个任务红球的首次原始像素唯一对应发生在 r20 obs91 / 72.46秒；没有唯一绑定的WM轨迹，没有确认、抓取或送达。未将这一离线身份对应补充到在线脑的对象表。

## 已观察到的改进及剩余失败

本局的动作结果依据实际进入了下一次模型请求：r20.state.recent_actions保留r19的37.342494cm新鲜检测；r21.state保留两次抓取的holding、观测编号、记忆距离、视觉方位及旧位置匹配数。r49.state也保留r48的失败结果、新鲜距离28.697687cm、方位2.614814°及观测编号。新鲜检测单独存放，没有覆盖WM对象表几何。

r21、r36、r42的 go_to 返回 `known_route_exhausted_needs_exploration`；r29返回 `route_no_progress`。这些失败是明确的动作退出，不能改写为成功到达绿色区。模型在这些退出后继续探索。本局没有以先前45步上限导致的长时间往返来代表所有导航行为；实际路线回归和界限见 `navigation-regressions.json`，其分析只使用脑能获得的里程计、道路与视觉观测。

r48请求 `go_to(storage-zone_053)`。obs246时仍在路上；motion152转向30.207778°，obs247仍在路上；motion153前进10cm后obs248仍在路上；motion154再转向12.882914°，obs249仍在路上。motion155前进8.653088cm后，obs250首次记录onRoad=false，时间245.36秒，位置right100.9cm / forward25.4cm，heading -173.8°。该前进接口返回 `completed=true`，但动作层依据新的道路观测返回 `visual_standoff_blocked`，并没有把执行完成当成任务成功。

obs250中的绿色区新鲜距离28.697687cm、方位2.614814°已落入原视觉停靠范围，但车辆已离路，不能仅凭这两个数宣布到达成功。缺口在于视觉转向后的前进没有在运动前挡住这次道路边界越出；事后失败判定仍保留了正确证据。r49–52的四次explore没有motion，位置和245.36秒保持不变。r53完成四视角扫描也没有恢复到道路上。obs250–266共17次观测均为off-road。

模型选择了目标级go_to；上述转向与前进量由确定性动作代码产生。因此这次离路不能直接归因于模型给出了错误运动参数。冻结请求说明了出口相对角度和历史绝对朝向，但没有明确说明对象bearing右正、heading/出口左正的符号差异；这是可独立检查的请求信息缺口，不构成它直接导致motion155离路的证明。后续修复与测试不属于本局结果。

## 离线报告、重放与归档完整性

定位统计有17个已唯一绑定的CONFIRMED红球轨迹观测样本，平均误差5.682209cm、RMSE5.723675cm；另有1个确认轨迹观测无法计入。每个轨迹、每次观测计一个样本，重复位置估计也计入，不能当成17次独立测量。完整样本与身份对应保存在 `report/evaluation.json`。

离线LLM记录重放为54/54轮、57/57调用匹配，完整记录除mode字段外一致，网络调用0、环境读取尝试0、输入证据未变。它重放保存的状态和请求，不运行机器人动作，也不是全仿真重放；通过不会改变本局FAIL。详细结果在 `llm-replay/replay-checks.json`。

`archive-integrity.json` 对record、samples、sensor-audit、captures四个压缩包流式复算压缩及展开后的字节数和SHA256，全部与原始 `map-05-run-1/evidence.json` 一致，没有重压缩或修改原始文件。

record压缩文件为 **61,774,347字节（58.912608MiB）**，展开为89,427,010字节；压缩文件低于100MiB，因此本局不需要为该上限拆块。原record压缩SHA256为 `0ee06cf2f7103e75cc99461525c35450752c3ea08a34aff4b8adb6df1d99baad`，展开SHA256为 `d20418d595b8e3f375d7eda8a105ad0f3821a256ca1d2763c10fa7fed82561c2`。

上述路径以本分析所在的 `artifacts/autonomous-brain/map05-run-07/` 为基准；全局运行索引是 `artifacts/autonomous-brain/LIVE_RUNS.md` 和 `artifacts/autonomous-brain/live-runs.json`。复算命令从仓库根目录运行，输出目录必须是新的：

```sh
python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/map05-run-07/map-05-run-1 --out <新的评测目录>
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/map05-run-07/map-05-run-1 --out <新的重放目录>
```
