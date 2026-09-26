阶段 1 原始证据交付，供外部 reviewer 独立复算。任务为 map-05：“把两个红球送到绿色存放区”。本次仅同步与归档，没有重跑仿真、继续开发、启动阶段 2 或改写原结果。

- 冻结源码：[d1538f7570a42b760ad518f133eaefd7bcac83a8](https://github.com/54dK3n/wm_bench/commit/d1538f7570a42b760ad518f133eaefd7bcac83a8)
- 原报告与本标签目标：[4a48664eecd3f46984f9ca48674aefe53fd9518d](https://github.com/54dK3n/wm_bench/commit/4a48664eecd3f46984f9ca48674aefe53fd9518d)
- [原 REPORT.md](https://github.com/54dK3n/wm_bench/blob/4a48664eecd3f46984f9ca48674aefe53fd9518d/artifacts/autonomous-brain/stage1-review-20260926/REPORT.md)、[METRICS.json](https://github.com/54dK3n/wm_bench/blob/4a48664eecd3f46984f9ca48674aefe53fd9518d/artifacts/autonomous-brain/stage1-review-20260926/METRICS.json)、[原 SHA256SUMS](https://github.com/54dK3n/wm_bench/blob/4a48664eecd3f46984f9ca48674aefe53fd9518d/artifacts/autonomous-brain/stage1-review-20260926/SHA256SUMS)

下载附件 `wm-bench-stage1-20260926-evidence.tar.gz`（154856805 字节）。包内保存原清单的全部 79 个文件、原清单本身及新增恢复/复核文档，共 85 个成员。原始 record、完整观测和模型日志作为 Release 附件提供，没有加入 Git。

压缩包 SHA256：

```text
67f148321e60814fd8195c98b4f1d40f07cd83f9eb0b9f61b02454d9d30edd1f
```

下载同名 `.sha256` 后执行 `shasum -a 256 -c wm-bench-stage1-20260926-evidence.tar.gz.sha256`。完整恢复步骤与四个只读复算命令见附件 `RESTORE.md`。附件 `SECRET_SCAN.json` 记录原件/压缩展开内容的敏感信息检查及限制；没有附带账户凭据。

三个复核入口见附件 `REVIEWER_ENTRYPOINTS.md`：

1. r102 的 190.4 cm 是沿观测道路实际运动的累计里程；未到候选。原角度门限下没有合格出口，完整候选换位成功数为 0。实现/单测与正式闭环成功分别说明。
2. 原全局 Judge 仍是 2 match / 2 unverifiable；全部四动作的前缀诊断为 4 match。两份脚本、输入边界及原件均保留，冲突观测没有删除。
3. frame 590 = observation 590 = r110 / tick 28756。脑端 perception 误贴旧球标签，离线全局绑定随后发现歧义。最终放置 witness 是 249/591，完成复观测是 594；状态、去重和 done 的证据字段已逐项索引。

原报告内“尚未外部归档”保留为当时事实；本 Release 提供后续交付，不重写其结论。
