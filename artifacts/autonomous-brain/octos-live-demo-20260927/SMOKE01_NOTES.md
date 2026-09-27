# smoke-01：原局停止与首次直接阻塞

这是新增一球开发接线局，不是原双球阶段 1。冻结源码 `6838a78c79af04d2e840c4a9d383924d63ef7644`，实际编排为 `octos_robots` 的 `orchestrator.executor.Executor`，版本 `33af31baefc9b3beaa855f33849d52254aaa8c4b`。源码前后哈希相等，平台原始导出完整。

实际完成 64 条轮次记录；第 65 次真实模型输出为合法 `pick`，该轮已产生运动，随后按开发停止请求向大脑发送 SIGINT。`brain/summary.json` 保留原始 `reason="not_started"`：这是原 `finally` 默认字段残留，**不能解释为本局未运行**。停止依据是 `raw/smoke-01/map-05-run-1/development-stop-request.json`，原 summary、日志和尾部未补写。

首个直接阻塞是 r35 的逐次抓取授权：`target_027` 已确认、抓取几何成立，但与旧 LOST 假设 `target_017` 存在身份竞争，因而没有实际发出 grab。原像素未提供足以安全解除竞争的匹配依据；没有把 LOST/STALE 改为 CONFIRMED，也没有删除旧义务。后续重复接近和抓取决策未解决该竞争。

模型反馈另有一处直接可修复缺口：紧凑动作摘要漏掉 `grab_authorization` / `authorization_recovery`，而原 guard 建议继续 `go_to`。本轮后续仅补有界失败摘要和合法探索提示，保留原安全授权条件；改动后的新局单独记录。

独立一球 smoke 验收 **FAIL**；物理交付、脑端 DELIVERED、独立观测命令链均为 0。完整轮 64、模型调用 65、WM 快照 311、桥 observe 请求 312 分别计数，不能互相补齐。严格转录回放由于中断尾部第 65 条模型调用没有完整轮记录而 FAIL，原结果保留。原 PNG 的四个关键帧及哈希见 `raw/smoke-01-keyframes/INDEX.json`，其中历史发现 frame 31、确认目标 frame 115、抓取拒绝 frame 184、最后观测 frame 311 均来自本局原始记录。

计数复算：`python3 artifacts/autonomous-brain/octos-live-demo-20260927/scripts/summarize_demo.py --out /tmp/wm-octos-demo-metrics-new.json`。待本轮所有选择局结束且独立评测落盘后运行；输出已存在即拒绝覆盖。脚本只计数和引用既有独立结论，不发起模型、仿真或重新评分。
