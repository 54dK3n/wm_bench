# 当前状态：双球开发基线 FAIL，已停止

冻结 `d6c107f197a1845f8cc1ba66a413512f9a1c5b71`（生产文件同 c4bf08e）的真实双球基线已执行，独立 evaluator 实际生成 FAIL；driver/evaluator 均 exit 1。73 次模型调用、73 dispatch / 72 judge、349 观测，pick 2、grab 4、观测抓持成功 1，release / 脑端 DELIVERED / done 均 0。

首球持物后的存放路线重复受净空阻塞，r73 turn 与恢复 odometry 均收到 409 BRIDGE_CLOSED；未知结果未重发。record/captures/envelope 等导出失败，物理两球身份、物理交付数及平台 run ID 无法独立核验，不能用缺失推断为真值 0。控制器关闭根因未知。首球未交付，交付后第二球采样窗口 NOT_EXERCISED，未实施新窗口修复。

未做推测性小修、未开第二局；阶段 2、十布局和真机未启动。[第一局一球 PASS](octos-minimal-demo-next/REPORT.md) 与[第二局一球 PASS](one-ball-review-next/REPORT.md) 原样保留，不据此推算成功率。

[本轮一页报告与实际命令/恢复/复算](two-ball-demo-next/REPORT.md) · [指标](two-ball-demo-next/METRICS.json) · [原始日志 Release](https://github.com/54dK3n/wm_bench/releases/tag/two-ball-baseline-20260927-d6c107f)

证据已于 2026-09-30 发布；七个附件均匿名完整下载并通过 SHA256 校验。[公开下载验证](two-ball-demo-next/PUBLICATION_VERIFICATION.json)。此次交付续办未启动新局、未修改生产代码，原 FAIL 与缺失平台原件事实不变。
