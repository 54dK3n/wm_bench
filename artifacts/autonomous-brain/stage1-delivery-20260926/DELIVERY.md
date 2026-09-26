# 阶段 1 同步与复核交付

本次只同步 Git 提交、检查并归档已有证据、补充复核入口。没有修改生产源码或原结果，没有重跑仿真或模型，也没有启动阶段 2。

## 提交与远端

本地/远端开发分支均为 `codex/autonomous-brain`；fetch 和 push 的目标均是 `github.com/54dK3n/wm_bench`，通过 SSH 推送。交付前本地 HEAD 为 `4a48664eecd3f46984f9ca48674aefe53fd9518d`，远端为 `46a297529224e49ffc75976d7487643765af4a37`，存在严格快进关系：

```text
46a297529224e49ffc75976d7487643765af4a37
  └─ d1538f7570a42b760ad518f133eaefd7bcac83a8  冻结源码
       └─ 4a48664eecd3f46984f9ca48674aefe53fd9518d  原验收报告
```

已通过非强制 push 同步这两个提交。随后 fresh `git ls-remote` 确认远端 HEAD 为 `4a48664eecd3f46984f9ca48674aefe53fd9518d`，并通过无认证的 GitHub HTTPS 请求读取两个完整提交与四个指定报告文件；远端文件 SHA256 与本地完全相同。证据见 [REMOTE_VERIFICATION_INITIAL.json](REMOTE_VERIFICATION_INITIAL.json)。本目录与新增复核入口在其后追加文档提交，不更改上述两提交。

- [冻结源码提交](https://github.com/54dK3n/wm_bench/commit/d1538f7570a42b760ad518f133eaefd7bcac83a8)
- [原报告提交](https://github.com/54dK3n/wm_bench/commit/4a48664eecd3f46984f9ca48674aefe53fd9518d)
- [REVIEW.md](https://github.com/54dK3n/wm_bench/blob/4a48664eecd3f46984f9ca48674aefe53fd9518d/artifacts/autonomous-brain/stage1-review-20260926/REVIEW.md)
- [REPORT.md](https://github.com/54dK3n/wm_bench/blob/4a48664eecd3f46984f9ca48674aefe53fd9518d/artifacts/autonomous-brain/stage1-review-20260926/REPORT.md)
- [METRICS.json](https://github.com/54dK3n/wm_bench/blob/4a48664eecd3f46984f9ca48674aefe53fd9518d/artifacts/autonomous-brain/stage1-review-20260926/METRICS.json)
- [SHA256SUMS](https://github.com/54dK3n/wm_bench/blob/4a48664eecd3f46984f9ca48674aefe53fd9518d/artifacts/autonomous-brain/stage1-review-20260926/SHA256SUMS)

## 证据包与安全检查

文件名 `wm-bench-stage1-20260926-evidence.tar.gz`，154856805 字节，SHA256：

```text
67f148321e60814fd8195c98b4f1d40f07cd83f9eb0b9f61b02454d9d30edd1f
```

包内保留原清单 79/79 文件和原清单本身；另附五项补充文件，总计 85 个成员，成员内容逐字节核验通过。完整成员清单和哈希见 [ARCHIVE.json](ARCHIVE.json)。原 `record.json.gz` SHA256 仍为 `9719232ef9cebbaed6b82392324a34c4851b373221f47cee438c1d5feb9e2e17`，原正式评测 SHA256 仍为 `c8e8fad2a65e995b7c34d85ca88fef27a803ab2c5bc77b73c545ffdab35c5898`。

[SECRET_SCAN.json](SECRET_SCAN.json) 记录原件及 gzip/tar 展开扫描：105 个单元、315728888 字节，阻止上传的发现为 0。三处 `client_token` 已确认为原驱动器占位符，两处 Authorization 是运行时变量表达式，均显式保留分类。实际本机敏感环境值仅在内存中用于精确比对，不进入报告或归档。模式扫描的边界也写入报告。

归档与原始日志均放在被 Git 忽略的目录中，不提交 raw、record、完整观测/模型日志或二进制分片。[RESTORE.md](RESTORE.md) 给出下载后校验、恢复到新 clone 和只读复算步骤。

Release 标签 `stage1-known-two-20260926-d1538f7` 已非强制推送，精确指向原报告提交。Release 草稿已保存，但附件尚未上传，草稿不对外可读。归档发布状态必须以 GitHub Release 公共页面及下载核验为准；仅创建本地压缩包或 Release 草稿不算外部交付完成。浏览器扩展曾返回 `Not allowed`，上传工具要求启用文件 URL 访问权限，原生上传也遇到浏览器交互中断；未为此自行扩大扩展权限。当前环境没有可用的 GitHub API 上传凭据，SSH Git 推送凭据不具备 Release 附件上传接口；因此现有可用上传通道仍待上述浏览器权限或用户手动上传，不能以本地文件路径宣称外部 reviewer 已可下载。

## 三个复核入口

完整索引见 [REVIEWER_ENTRYPOINTS.md](../stage1-review-20260926/REVIEWER_ENTRYPOINTS.md)。

1. r102 `go_to(target_122)`，候选来自观测 467，脑里程计位置 `[-0.002,1.358]m`；实走观测 508–522、累计190.4cm，未到候选。原 `<45°` 门限下零个出口匹配，停止原因 `reposition_recorded_direction_not_uniquely_observed`。完整候选换位加视觉站位验证成功数为 0，不能把实现/单测或后续另选 explore 算成该换位闭环成功。
2. 原全局 Judge 使用全部594观测，仍为2 match / 2 unverifiable；前缀诊断对全部四次抓放统一使用各动作开始之前的完整观测前缀，结果4 match。两个脚本、各窗口及冲突观测保留位置均已列明，原结果不覆盖。
3. frame590为观测590、r110、tick28756。脑端 perception 先误贴旧球标签，离线全局绑定随后发现冲突并标歧义。frame590不是成功交付 witness；实际 witness 为249/591，最终 done复观测为594。逐帧生命周期、旧球排除、去重与done字段路径均可从原件核查。
