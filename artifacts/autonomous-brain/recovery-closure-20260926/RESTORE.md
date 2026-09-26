# 恢复与离线复算

本轮证据 Release：
[recovery-closure-20260926-1117336](https://github.com/54dK3n/wm_bench/releases/tag/recovery-closure-20260926-1117336)

下载附件 `wm-bench-recovery-closure-20260926-evidence.tar.gz` 和同名 `.sha256`。压缩包哈希以独立侧车文件为准，原文件哈希在 `SHA256SUMS`；不对包含自身的归档制造自引用哈希。

```sh
shasum -a 256 -c wm-bench-recovery-closure-20260926-evidence.tar.gz.sha256
mkdir wm-recovery-evidence-new
tar -xzf wm-bench-recovery-closure-20260926-evidence.tar.gz -C wm-recovery-evidence-new
cd wm-recovery-evidence-new
shasum -a 256 -c artifacts/autonomous-brain/recovery-closure-20260926/SHA256SUMS
```

目标必须是新的空目录。包中只有仓库相对路径的普通文件，没有绝对路径、`..`、符号或硬链接。原始记录保留原字节；原清单、扫描说明、压缩包侧车和上传后验证分别记录，避免哈希自引用。不要运行仿真来恢复证据。

在另一新目录取得精确冻结源码：

```sh
git clone https://github.com/54dK3n/wm_bench.git wm-recovery-source-new
git -C wm-recovery-source-new checkout --detach 1117336bcb875e0700ebe6363d6154fc0409a8a0
```

将恢复出的本轮 `artifacts/autonomous-brain/recovery-closure-20260926` 复制进这个新的源码目录，不覆盖原工作仓库或历史证据。所有复算输出使用新的路径。正式结果的只读独立复算为：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/recovery-closure-20260926/raw/formal-stage1/map-05-run-1 --out <new-stage1-report-directory>
```

如果 `REPORT.md` 说明阶段 2 已运行，再对 `raw/formal-stage2/map-05-run-1` 执行同一评测器，输出另一新目录。若阶段 2 未运行，不把缺目录当成恢复故障，也不自行补跑。独立评测可使用包内 record/capture 真值，机器人程序不能读取这些文件。

模型严格离线回放使用 `tools/replay_brain_llm.py --input <trial-directory> --out <new-directory>`；该工具禁止网络和读取环境，沿用日志版本和原参数。测试命令及统计范围见 `TEST_COMMANDS.md`。生命周期证据导出脚本为 `raw/discovery/export_lifecycle_examples.py`：将脚本复制到另一个新空目录，再从冻结源码根目录执行副本；它会在脚本旁建立新 `lifecycle-examples`，拒绝覆盖已有目录。

## 历史证据及冻结平台

本包不重复装入两份已经发布的旧证据。需要历史模型回放、固定传感诊断或平台源码时，分别下载并按各自恢复说明核验：

- [历史阶段 1 Release](https://github.com/54dK3n/wm_bench/releases/tag/stage1-known-two-20260926-d1538f7)：`wm-bench-stage1-20260926-evidence.tar.gz`，SHA256 `67f148321e60814fd8195c98b4f1d40f07cd83f9eb0b9f61b02454d9d30edd1f`，原清单 79 文件。
- [上轮停止 Release](https://github.com/54dK3n/wm_bench/releases/tag/stage2-offline-stop-20260926-ba9edd3)：`wm-bench-stage2-offline-stop-20260926-evidence.tar.gz`，SHA256 `717bd10be05727ea98d3284a3456bf999243a0c7963797ac48cbc11ca294c29a`，原清单 95 文件。

本包另含 `raw/gate/frozen-platform-runtime-and-boundary-tests.tar.gz`，保存本轮冻结平台的 58 项运行源码/资产、桥边界测试和 Python 标准库资产；文件清单和压缩包 SHA256 见 `PLATFORM_RESTORE.json`。需要运行带真实平台参数校验的离线测试时，在新的源码目录中展开这个子包，恢复 `workspaces/guangyang-platform/projects/car-python`。平台 commit 为 `54b36f82109836226cf654e9a676ddf0c3b07cd0`；实际 WorldModel 文件哈希、加载路径、依赖锁和模型配置见 `FROZEN_INPUTS.json`。平台子包不含 `.git` 或本机配置，不覆盖新候选 `autonomous_brain`。只读正式评测和模型回放无需启动平台。

另有 `raw/gate/robot-checkpoint-clock.test.js` 保存完整冻结 manifest 所列的时钟测试原件；其恢复位置和 SHA 见 `PLATFORM_RESTORE.json.supplemental_files`。60 文件子包原字节不改，加上这一补充文件共恢复61文件。平台子包只恢复文件内容，不声称恢复 Git 元数据。在新的源码目录中核验恢复文件：

```sh
tar -xzf artifacts/autonomous-brain/recovery-closure-20260926/raw/gate/frozen-platform-runtime-and-boundary-tests.tar.gz
cp artifacts/autonomous-brain/recovery-closure-20260926/raw/gate/robot-checkpoint-clock.test.js workspaces/guangyang-platform/projects/car-python/tests/robot-checkpoint-clock.test.js
python3 - <<'PY'
import hashlib, json
from pathlib import Path
m = json.loads(Path('artifacts/autonomous-brain/recovery-closure-20260926/PLATFORM_RESTORE.json').read_text())
for name, expected in m['files'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == expected, name
for entry in m['supplemental_files']:
    assert hashlib.sha256(Path(entry['restore_path']).read_bytes()).hexdigest() == entry['sha256'], entry['restore_path']
print('platform content verified:', len(m['files']) + len(m['supplemental_files']), 'files')
PY
```

`TEST_COMMANDS.md` 中 `verify_brain_revision_inputs.py` 是原工作机器执行的完整历史完整性门：它还要求原嵌套平台 Git checkout 及源码根中的历史阶段1原件，与 `--restore` 的第二份隔离副本。只解压本子包不会重建那些 Git 元数据，因此外部内容恢复使用上述逐文件 SHA 校验，不直接把该机器相关命令当作便携恢复命令。平台 commit 来源保留在正式前后 manifest 和完整性输出；不创建伪造 Git 元数据来使核验通过。

`FROZEN_INPUTS.json` 中 `formal_run:true` 是模型配置验证字段，实际运行次数及结果只看 `REPORT.md`、`METRICS.json` 和原运行输出。历史任务级 PASS、全局 Judge 原 2 match / 2 unverifiable 不因本轮新诊断而改写。
