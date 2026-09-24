# 仓库与本地实验数据

本仓库保存可审查的源码、测试、文档、报告、校准/评测 JSON、冻结源码索引以及 WorldModel Git 历史 bundle。旧实验字节、判定结果与失败记录保持原样。

大型原始证据保留在当前工作目录，通常不以展开形式写入 Git：

- 原生帧 PNG（demo 抓取/送达关键帧除外）；
- 完整 `*.record.json`、`*.samples.json`、`*.partial.txt`；
- `attempts/` 下重复的 JSON、日志副本（视觉/关键帧清单保留）；
- 历史 `artifacts/inloop_snapshot/` 快照与运行 PID。

这些是实验数据，不是可以随意删除的缓存。本次仅设置忽略规则，没有删除、改写或重新运行实验。文件索引见 `local-evidence-manifest.json`，包含仓库相对路径、字节数、SHA256 与分类。清单不包含凭据或原始图像内容。

## 核验与备份

在保有原始数据的工作目录执行：

```sh
python3 tools/repository_evidence.py --check
```

本次 C 交付有一个明确例外：`artifacts/inloop/refactor/evidence-packages/` 保存 opt-2 round-3 与 refactor round-1 的已执行布局证据压缩包。完整原生 record 已包含视觉 PNG 字节；恢复工具据此逐字节导出 PNG，避免在包内重复存储，独立的抓取/送达截图则直接保存。日志、samples、清单和 record 的原字节及历史路径均保留。平台代码、服务器数据、浏览器配置和认证存储不入包。

```sh
python3 tools/package_refactor_evidence.py --restore
python3 tools/package_refactor_evidence.py --check
```

恢复会验证包及所有文件的 SHA256，拒绝覆盖任何不同的已有文件。上述范围之外，在只克隆源码的新机器上仍须向原持有人索取缺失数据，按本地清单中的相对路径恢复后核验；缺失会明确返回非零退出码，不跳过或假装齐全。GitHub 尚未备份全部历史原始数据，迁移或清理本机前应另行备份。

新增实验证据后，先检查 `.gitignore`、确认留存范围，再更新清单：

```sh
python3 tools/repository_evidence.py --write
git diff -- docs/local-evidence-manifest.json
```

此命令只更新清单，不上传、移动或删除数据。不要在缺失旧数据的新 clone 上运行 `--write` 来掩盖缺失。

## 可复现边界

`tools/tests/test_inloop_host_io.js` 的真实回放和 `tools/tests/test_opt2_reporting.py` 等依赖原始 record/帧；未恢复数据时不能运行完整测试集。报告中的本机绝对路径保留作为历史证据，可能需要通过恢复原路径或在副本上适配工具才能复算。没有放宽测试或使用 skip/xfail。

程序和历史日志采用 `.gitattributes` 的 `-text`，避免检出时修改换行影响原有哈希。后续修改程序仍应生成新版本和新的实验目录。
