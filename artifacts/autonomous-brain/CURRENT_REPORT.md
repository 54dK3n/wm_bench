# 当前轮次：主动确认局部通过，阶段 1 FAIL，已停止

冻结源码 `dec5b078d6711bdfda972ca4632c200e235dfb7e`。主动确认采样、短段聚合、候选过滤、探索语义及发现摘要修复，经 Python **1448**、Node **29**、冻结平台 **15** 项验证通过。唯一正式 map-05 已知两球局达到 **200 轮**上限，**1047.64** 仿真秒、**206** 次模型调用，仅 **1/2** 有效交付，未主动 done，独立评测 **FAIL**。第二候选在第105轮已确认，第106轮开始因净空与记录路线到达姿态受阻；5次候选换位均未完成。失败后未改源码或重跑；阶段 2 **未运行、未验收**，十布局和真机未启动。

[本轮报告](active-confirmation-20260926/REPORT.md) · [统计](active-confirmation-20260926/METRICS.json) · [修复范围](active-confirmation-20260926/REVIEW.md) · [首次阻塞](active-confirmation-20260926/FIRST_BLOCKER.md) · [命令和范围](active-confirmation-20260926/TEST_COMMANDS.md) · [Release 证据](https://github.com/54dK3n/wm_bench/releases/tag/active-confirmation-20260926-dec5b07) · [恢复说明](active-confirmation-20260926/RESTORE.md)

[历史 d1538f7 阶段 1 PASS](stage1-review-20260926/REPORT.md) 及全局 2 match / 2 unverifiable、动作前缀 4 match 原样保留；[1117336 阶段 1 FAIL](recovery-closure-20260926/REPORT.md) 亦保留，均不作为本候选结果。原始日志只在 Release 附件，未加入 Git。
