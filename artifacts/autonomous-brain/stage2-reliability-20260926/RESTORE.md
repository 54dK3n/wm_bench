# 恢复本轮停止证据

本轮是离线修复候选封存，联合前置 FAIL、正式运行 0。附件不含真实密钥或运行凭据。不要执行仿真或模型任务来“恢复”证据。

Release：<https://github.com/54dK3n/wm_bench/releases/tag/stage2-offline-stop-20260926-ba9edd3>

下载 `wm-bench-stage2-offline-stop-20260926-evidence.tar.gz` 及同名 `.sha256`；在下载目录先执行：

```sh
shasum -a 256 -c wm-bench-stage2-offline-stop-20260926-evidence.tar.gz.sha256
mkdir wm-evidence-restored-new
tar -xzf wm-bench-stage2-offline-stop-20260926-evidence.tar.gz -C wm-evidence-restored-new
cd wm-evidence-restored-new
shasum -a 256 -c artifacts/autonomous-brain/stage2-reliability-20260926/SHA256SUMS
```

目标必须是新的空目录。归档成员只有仓库相对路径的普通文件，不含绝对路径、`..`、符号链接或硬链接。清单覆盖归档里的原始证据和交付文档；清单自身及随后生成的扫描说明不自引用。每个原始证据文件保留原字节，未脱敏改写验收数据；包的 SHA256 另见同名附件。

获取代码使用新的 checkout，精确版本为：

```sh
git clone https://github.com/54dK3n/wm_bench.git wm-source-new
git -C wm-source-new checkout --detach ba9edd36a773b896f9fe6e9eb37ed0f75e8e8a7c
```

本轮附件包含新证据目录中的开发红测试、通过测试、合成诊断、历史日志的只读新评测/严格模型回放和停止反例。**不重复打包隔离恢复的整份旧证据**；历史输入从原 Release 获取：

<https://github.com/54dK3n/wm_bench/releases/tag/stage1-known-two-20260926-d1538f7>

其 `wm-bench-stage1-20260926-evidence.tar.gz` SHA256 为 `67f148321e60814fd8195c98b4f1d40f07cd83f9eb0b9f61b02454d9d30edd1f`。按原 `RESTORE.md` 恢复到另一空目录，验证旧 79 项清单；脚本的 `--input` / `--brain-dir` / `--restore` 指向该目录，输出必须是新目录/文件。旧开发报告中的 `/Users/ken/...` 是来源记录，不是外部下载入口。

边界反例：把归档内 `raw/boundary-review/reproduce_invalid_endpoint.py` 复制到新空目录，从上述冻结仓库根目录运行复制的脚本。使用 `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 <脚本绝对路径>`。脚本只使用合成配置并禁止网络，保留真实日志消费者输出；预期复现已知缺口，不是正式任务。

其余定向复核见 `REVIEWER_ENTRYPOINTS.md`。完整历史源码/平台恢复资料在原包中；本轮平台 commit 仍为 `54b36f82109836226cf654e9a676ddf0c3b07cd0`，WorldModel 和 Python/Node 来源记录在 `SOURCE_PROVENANCE.json`。本轮正式模型配置的 `formal_run:true` 是配置验证字段，不表示运行过正式任务。
