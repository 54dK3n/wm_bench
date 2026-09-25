# 当前任务：WorldModel + 外部单动作大模型自主小车

2026-09-25 最新范围已替代下文旧 v4 阶段门禁：平台够用即可，octos 编排、技能契约和逐条确定性对照暂缓。旧 FAIL 与历史证据不变。

- 平台够用门禁：PASS。新跑的 map-05 固定动作诊断有逐条一致的桥检测，四类均非空，见 [新运行报告](../artifacts/autonomous-brain/fresh-map05-gate-20260925/REPORT.md)。短路线没有进入指定应见距离窗，因此另保留 [历史长路线只读复算](../artifacts/autonomous-brain/platform-gate-20260925/REPORT.md)；应见召回与两次检测一致性均只报告。
- 外部大脑已实现于 `autonomous_brain/`，WorldModel 使用官方 main 的锁定版本和显式 `max_range_m=0.9`，沿用 M5。
- 真实平台与外部大脑的假模型传输联调、非法 JSON 停止和不联网模型回放均通过。它们不是正式模型或双球任务验收。
- 当前配置已完成：Kimi 密钥只保存于 Git 忽略的 `.env.local`，鉴权通过；driver 自动加载，无需手工 export。原温度 0 的探测被服务拒绝后，用户已明确允许 K2.6 非思考模式、固定温度 0.6；新参数真实 JSON 输出验证通过。完整无密钥证据见 [Kimi 接入报告](../artifacts/autonomous-brain/kimi-setup-20260925/REPORT.md)。尚无本轮 map-05 成功局，未运行十布局。
- 正式首局已结束并明确 FAIL：40 轮、40 次模型调用、0 抓取、0 送达，导航受阻后盲退导致离路；[完整失败证据](../artifacts/autonomous-brain/map05-run-01/FAILURE_ANALYSIS.md)保留。已修复恢复动作、近路口判定、直接节点间行驶的出口登记，并明确模型必须选择当前相对出口。确认和抓放门槛不变；163 项 Python 与 3 项 Node 检查通过。
- 第二局第 8 轮模型请求超时，第三局第 2 轮连接提前关闭，均为 FAIL、0 抓取和送达。完整日志、独立评测和来源哈希见[真实运行记录](../artifacts/autonomous-brain/LIVE_RUNS.md)。近路口修复已由第二局实际观测验证；不能把连接失败解释为新动作逻辑失败，也不能当作动作通过。
- 第四局首请求为 URLError，无动作；随后同配置模型列表检查返回 HTTP 200。四局完整证据已保存。LLM v7 在流式接收基础上加入正式大脑显式启用的两次瞬态连接重试，每次调用、错误和等待均记录；154 项客户端测试通过，旧失败记录回放不变。
- 第五局已导出 FAIL：42 轮、47 次调用、147.52 仿真秒，首球确认但没有抓放。47 次模型调用离线回放一致；运行中源码未变。停止原因为离线复现动作边界缺陷，不能误记为未执行的 go_to/place 在该局失败。Actions v6 修复下一路点选择、离路/受阻后退及另一已知球误作放置见证；LLM v8 提示优先处理已确认任务目标。207 项相关测试通过，[修复证据](../artifacts/autonomous-brain/action-safety-fix-20260925/REPORT.md)。
- 第六局已导出 FAIL：46 轮、49 次调用、567.38 仿真秒；首个红球抓取成功，但导航循环、停靠观测冲突及下一状态缺少具体依据阻碍送达。完整证据见[失败分析](../artifacts/autonomous-brain/map05-run-06/FAILURE_ANALYSIS.md)。49 次模型调用离线回放一致。Actions v8 保留路线进度、识别路线尽头与重复状态，并按实时视觉作有界停靠校正；Runtime v2 补齐下一状态的观测依据。256 项整体测试通过，补充抓取证据字段后 43 项复验通过；[修复记录](../artifacts/autonomous-brain/route-visual-feedback-fix-20260925/REPORT.md)。
- 第七局已完整保存 FAIL：首个红球抓取后，视觉停靠的一次斜向前进超过已观测左侧净空，随后离路；54 轮、57 次调用均已离线回放。失败记录见 [第七局分析](../artifacts/autonomous-brain/map05-run-07/FAILURE_ANALYSIS.md)。Actions v9 对直线接近按道路侧向/前方净空限幅，因曲率仍离路时只逆转最后一小段已测直线位移；近处目标先转向重获观测。Runtime v3 / LLM v9 明确物体方位与出口角的相反正负方向，携带净空失败依据；[修复记录](../artifacts/autonomous-brain/road-clearance-fix-20260925/REPORT.md)。
- 第八局已保存 FAIL：54 轮、64 次调用、226.04 仿真秒，首球抓取与绿色区前停靠成功，但 place 在 5 次平移和 3 次转向后用尽原联合预算，球仍在夹爪内；随后离路状态阻断导航。64 次模型调用均严格离线回放；[第八局分析](../artifacts/autonomous-brain/map05-run-08/FAILURE_ANALYSIS.md)。独立 evaluator v2 加入终态、源码证据和可绑定抓放 Judge 核验，历史结论不改写。
- 当前修复：放置分别限制转向/平移，记录本次真实运动用于归路；放置判据与归路结果分开记录。Perception v5 用释放后同帧唯一见证关联重复轨迹；合法近场无新轨迹的见证仍可确认送达。Runtime v4 将归路成败与观测编号交给下一轮模型。原始轨迹、失败和回放日志全部保留。
- 第九局已完整保存 FAIL：77 轮、89 次调用、354.56 仿真秒，首球有效送达（独立真值和未撤销原生事件均通过），第二球已确认但 pick 接近后离路；几何已对准，唯一失败项是旧 onRoad 条件，且没有抓取归路。89 次模型调用严格离线回放一致；[第九局分析](../artifacts/autonomous-brain/map05-run-09/FAILURE_ANALYSIS.md)。
- Actions v12：pick 从新鲜道路锚点开始，记录所有操纵动作；允许有界操纵暂时离路，每次前进检查新鲜净空，每步用里程计验证实际运动。原 CONFIRMED、距离/方位、三次抓取、持物及原位复看判据不变。成功或失败后只逆走本次实测路径，抓取与归路结果分开；未验证持物保留 pending 身份。Runtime v5 将新失败依据传入下一轮状态；[修复报告](../artifacts/autonomous-brain/pick-return-fix-20260925/REPORT.md)。
- 第十局完整保存 FAIL：55 轮、58 次调用、228.98 仿真秒，首球有效送达并归路，随后重复选择同一出口受阻。第 43 轮受阻短移误报到达路口，后续七次零进展；[第十局分析](../artifacts/autonomous-brain/map05-run-10/FAILURE_ANALYSIS.md)。58 次调用离线回放一致；8 份源码和 4 个 gzip 完整性通过。
- Actions v13：按当前出口方向先转向，重新观测并按实际航向匹配出口；阻挡结果优先于路口/新物体成功判断。Perception v6 / Runtime v6 / LLM v10 保留未确认即归档的 LOST 历史，但以明确观测依据标为退役假设；已确认 LOST、持物、释放未验证及缺失历史仍 pending。无身份合并、位置屏蔽或 DELIVERED 伪造；423 项合并离线测试通过，见[合并记录](../artifacts/autonomous-brain/exit-alignment-fix-20260925/INTEGRATION.md)。
- 第十一局 FAIL、证据不完整：81 轮、94 次调用、429 次观测、378.36 仿真秒；正常停止后平台原生导出超时，缺 record/samples/captures/sensor-audit。首球仅有大脑观测放置证据，不能核算真值送达数、逐球真值时间线或 WM 真值误差。现存日志、停止请求、源码来源及离线回放全部保留；不以其他局证据补齐。
- Actions v14 将环视改为八次45°，补齐原四次90°扫描的方位空隙，保留旧四方向与独立位置确认要求。Navigation v3 的反向出口完成标记依赖当前唯一出口、实测位移和局部道路切线；15cm路口/15°出口/45°方向范围不变，路口身份歧义继续保留。合并447项离线测试通过，见[联合验证](../artifacts/autonomous-brain/navigation-reverse-fix-20260925/INTEGRATION.md)。
- Driver v5 改为评测侧分块导出；评测器 v3 增加相应源码格式兼容，判定条件不变。本机假模型的500帧压力检查及14帧短流程均通过，见[导出验证](../artifacts/autonomous-brain/export-fix-20260925/INTEGRATION.md)。下一正式目录 `artifacts/autonomous-brain/map05-run-12`。只有正式 map-05 成功后才能跑十布局。
- 第十二局完整导出 FAIL：14轮、17调用、70观测、45.98仿真秒，0/2有效交付。第14轮未确认对象输出被校验拒绝，修正请求连续断连/502/502后耗尽传输重试；未执行该轮动作，无外部停止。模型离线回放14/17、8源码证明、4gzip与envelope检查通过。第十三局使用相同冻结源码 `885c24f8d2b58870fe42c42d434610f9dab96a27` 和原参数运行，未因服务错误修改动作代码。
- 第十三局完整导出 FAIL：58轮、69调用、365观测、246.08仿真秒、0/2交付。首个已确认红球归档为LOST后，离线反例证明旧实现的完成义务无法解除，因此正常停止并保留失败。69次模型请求离线回放、8源码与4gzip及envelope校验通过；停止证据和全部旧报告原样保存。
- Perception v7 / Actions v15 / Runtime v7 / LLM v11：新轨迹独立三位置确认后，仅在原30cm同类门控的完整竞争集合中双向唯一时记录身份重获绑定；不改上游状态、ID、命中数或旧时间线。只有绑定后继按原抓放判据DELIVERED后才解除历史待处理义务，歧义与未核验释放继续失败。38项新定向测试和全部485项脑测试通过；第十三局365帧传感复放结果不变，未创建绑定。见[修复证据](../artifacts/autonomous-brain/reacquisition-fix-20260925/REPORT.md)。下一正式目录 `artifacts/autonomous-brain/map05-run-14`，十布局仍需实际成功局。

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
