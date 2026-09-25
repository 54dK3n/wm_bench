# 当前任务：WorldModel + 外部单动作大模型自主小车

2026-09-25 最新范围已替代下文旧 v4 阶段门禁：平台够用即可，octos 编排、技能契约和逐条确定性对照暂缓。旧 FAIL 与历史证据不变。

- 平台够用门禁：PASS。新跑的 map-05 固定动作诊断有逐条一致的桥检测，四类均非空，见 [新运行报告](../artifacts/autonomous-brain/fresh-map05-gate-20260925/REPORT.md)。短路线没有进入指定应见距离窗，因此另保留 [历史长路线只读复算](../artifacts/autonomous-brain/platform-gate-20260925/REPORT.md)；应见召回与两次检测一致性均只报告。
- 外部大脑已实现于 `autonomous_brain/`，WorldModel 使用官方 main 的锁定版本和显式 `max_range_m=0.9`，沿用 M5。
- 真实平台与外部大脑的假模型传输联调、非法 JSON 停止和不联网模型回放均通过。它们不是正式模型或双球任务验收。
- 当前配置已完成：Kimi 密钥只保存于 Git 忽略的 `.env.local`，鉴权通过；driver 自动加载，无需手工 export。原温度 0 的探测被服务拒绝后，用户已明确允许 K2.6 非思考模式、固定温度 0.6；新参数真实 JSON 输出验证通过。完整无密钥证据见 [Kimi 接入报告](../artifacts/autonomous-brain/kimi-setup-20260925/REPORT.md)。尚无本轮 map-05 成功局，未运行十布局。
- 正式首局已结束并明确 FAIL：40 轮、40 次模型调用、0 抓取、0 送达，导航受阻后盲退导致离路；[完整失败证据](../artifacts/autonomous-brain/map05-run-01/FAILURE_ANALYSIS.md)保留。已修复恢复动作、近路口判定、直接节点间行驶的出口登记，并明确模型必须选择当前相对出口。确认和抓放门槛不变；163 项 Python 与 3 项 Node 检查通过。
- 第二局也已 FAIL：第 8 轮模型请求超时，未生成该轮动作；此前近路口修复实测通过，0 抓取和送达。见[第二局证据](../artifacts/autonomous-brain/map05-run-02/FAILURE_ANALYSIS.md)。计划只增加网络等待时间后新建第三局；模型、温度、确认/抓放门槛和任务上限不变。下一步收集新局结果，按 [运行说明](AUTONOMOUS_BRAIN.md) 用独立真值/record 评测。不能把配置成功、鉴权成功或诊断结果当成正式任务成功。只有正式 map-05 成功后才能跑十布局。此前交付与检查见 [报告](../artifacts/autonomous-brain/REPORT.md)。
- Run 03 failed with RemoteDisconnected in round 2; evidence is in `artifacts/autonomous-brain/map05-run-03`, frozen source commit `fd68988`. LLM v5 uses a 180-second transport timeout; Actions v5 retains a road-compatible candidate viewing direction and stops on new confirmation. See `artifacts/autonomous-brain/scan-followup-fix-20260925/REPORT.md`. Confirmation, grasp/place gates and task limits are unchanged.

## 历史状态：v4 严格阶段验收

当时的 v4 指令替代下述 A→D 计划、旧比赛规则与验收。以下保留当时状态，不再控制本轮执行顺序。

2026-09-25 阶段 1 恢复验收 **FAIL / STOP，后续阶段保持停止**。平台已放行并保留 `virtual-cv`，新增评测逐帧核对内部原始检测、公开类别及相机坐标转换后的检测和桥结果，并检查应见、相机像素摘要、checkpoint 动画与拒绝调用。新日志存在应见漏检，没有修改门限。完整结果、逐帧失败和复算入口见 [阶段 1 恢复验收报告](../artifacts/inloop/v4/stage-1/restore-20260925/REPORT.md)。

旧空检测下的「record 确定性」和「经桥 observe」通过结论已作废，历史证据原样保留。最初断链的复现仍见 [复核报告](../artifacts/inloop/v4/stage-1/review-20260925/REPORT.md)。平台分支 `v4/robot-backend` 与评测分支 `v4/autonomous-observation` 均交付到用户指定的 `54dK3n/wm_bench` 仓库；版本与 SHA256 见新报告。

当前停在阶段 1，下一步应处理新日志中的应见漏检，并核查跨运行时严格动画公式复算差异；不能将它未经验证地归因为墙钟，也不能静默放宽门禁。再次验收必须新建证据目录。`workspaces/octos_robots/` 和 `workspaces/WorldModel/` 保持未开发状态，没有新增大脑、技能、LLM 调用或阶段 2 验收。原 octos 目录的未提交改动保持原样。进度与复跑入口见 [v4 工作说明](V4_AUTONOMOUS_LOOP.md)。

## 历史状态：A → B → C → D

本轮按用户新要求顺序执行。A 不跑仿真；B 完成后才开始 C；C 十布局行为等价验收通过后才开始 D。C 与 D 各最多三轮，不放宽门槛，不运行赛题1。

- A：已完成。DEMO/README相对链接、四关键帧、两球WM故事及可复算数值已保存；原证据未变，不做可选重跑/录屏。
- B：已完成。两个PR均合并，主仓fef0ba9b754ce9652836fdb720d1162dcadbc5ef。全部168测试和迁移基线原130测试通过；vendor锁定主仓，旧GY配置35场景168操作相等。
- C：第 1 轮未通过，暂停。模块化源码及预检完成；十布局原生 inputs 相等 0/10、events 相等 5/10、得分相等 8/10，程序错误 0。首个分歧均在感知返回；保存的首帧图像已有差异。未改平台动画、未换旧基线、未开始第 2 轮。见 [报告](../artifacts/inloop/refactor/SUMMARY.md)。
- D：未开始。仅在 C 通过后按 opt-2b 开始，最多三轮。

基线：`artifacts/inloop/opt-2/round-3/program.py`，SHA256 `59d8f617a7fd82135b710b6a32cf112b4c17c80aa770beb59407aa50d5cf17e6`。历史原始证据与冻结程序不得覆盖。B完成提交为 `40eebe2`。

原 demo 与 opt-2 round-3 是不同程序和不同运行。A 的文字与图片使用 demo 原局；不把后续程序的 SHA 写成 demo 身份。


C首轮程序：`wm-refactor-r1-20260924`，文件SHA256 `b31ed3b4c1ad4abe1a162526bdf07174e3259afc2d4d5c977b1e27e384e11381`。源码冻结提交 `4b26cf2`；正式预检630项Python及19项Node测试通过，批跑期间273项冻结文件未变。全部十局已完成并比较，执行台账为 `artifacts/inloop/refactor/round-1/progress.json`。

当前需要明确的范围：是否单独修复平台感知的浏览器时间依赖，并在同一修复环境重新运行旧程序建立对照基线，再按原 inputs/events/得分逐条相等门限检查新程序。此举改变环境及对照基线，超出 C 的“只整理代码、不修行为”；未经明确授权不执行。旧 opt-2 round-3 和本轮 FAIL 均须保留。
