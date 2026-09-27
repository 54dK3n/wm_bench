# 当前轮次：可执行恢复局部通过，阶段 1 FAIL，已停止

冻结源码 `a847a3c538c2787864633753b74dd906098ff6fd`。最终 Python **1516**、驱动 **29**、平台 **15** 项通过；合成组件、视点恢复与原生局部逆向执行分别留证。唯一正式 map-05 局在 **r97 / 673.06 秒**因模型 **HTTP 402**终止，97 次模型调用、596 次观测、白名单外调用 0、done 0，未到预算上限。

正式完整候选换位 **1 次成功**（2 尝试/1 到达）；主动采样3次、选定目标新增1个有效 hit，确认成功0次。脑端与 record 各记1球送达，独立观测命令链验收为0：第二次grab前已为STALE，抓取及后续交付链未通过。原全局与前缀Judge各2 match不能抵消这一拒绝。失败后未修源码、未重跑；阶段2未运行，十布局和真机未启动。

[报告](executable-recovery-20260927/REPORT.md) · [指标](executable-recovery-20260927/METRICS.json) · [修复复核](executable-recovery-20260927/REVIEW.md) · [首次阻塞与恢复](executable-recovery-20260927/FIRST_BLOCKER.md) · [抓放证据链](executable-recovery-20260927/EVIDENCE_CHAIN_REVIEW.md) · [复算命令](executable-recovery-20260927/TEST_COMMANDS.md) · [Release](https://github.com/54dK3n/wm_bench/releases/tag/executable-recovery-20260927-a847a3c) · [恢复说明](executable-recovery-20260927/RESTORE.md)

历史 [d1538f7 PASS](stage1-review-20260926/REPORT.md)、[1117336 FAIL](recovery-closure-20260926/REPORT.md)、[dec5b07 FAIL](active-confirmation-20260926/REPORT.md) 均保留；历史 Judge 口径与原始字节未改。raw、record和完整模型/观测日志仅在Release，不进Git。
