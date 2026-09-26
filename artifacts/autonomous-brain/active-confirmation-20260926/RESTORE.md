# 恢复本轮证据

冻结源码：`dec5b078d6711bdfda972ca4632c200e235dfb7e`。
本轮独立 Release：<https://github.com/54dK3n/wm_bench/releases/tag/active-confirmation-20260926-dec5b07>。
下载其中 `wm-bench-active-confirmation-20260926-evidence.tar.gz` 和同名 `.sha256`。压缩包与每个原始文件分别保留 SHA256；未改写验收原件。

在新的空工作目录恢复，不能覆盖已有验收目录：

```sh
shasum -a 256 -c wm-bench-active-confirmation-20260926-evidence.tar.gz.sha256
git clone --no-checkout https://github.com/54dK3n/wm_bench.git wm-bench-active-review
cd wm-bench-active-review
git checkout --detach dec5b078d6711bdfda972ca4632c200e235dfb7e
tar -xzf ../wm-bench-active-confirmation-20260926-evidence.tar.gz
shasum -a 256 -c artifacts/autonomous-brain/active-confirmation-20260926/SHA256SUMS
```

包内为仓库相对路径的普通文件，无绝对路径、`..`、符号链接、硬链接或重复成员。报告提交比冻结源码提交晚；包内报告文件是实际交付版本。`DELIVERY.json` 记录完整包的哈希、大小、成员数与原件逐字节一致性；`SECRET_SCAN.json` 记录扫描范围和逐项判定。发布后匿名下载验证另存 `PUBLICATION_VERIFICATION.json`，不递归装入它自己验证的包。

## 冻结平台与 WorldModel

本轮未修改平台。`PLATFORM_RESTORE.json` 的 `archive` 指向复用的原15MB平台子包，SHA256为 `bbce700c72de792084e1a6cea5b597bc21f9c8e5338dc857d0b080e197376d08`。子包含60个文件：58项实际运行文件/资产、桥接边界测试、Python标准库资产。另提供原字节的 clock 测试补充文件，共61项。

从仓库根恢复：

```sh
tar -xzf artifacts/autonomous-brain/active-confirmation-20260926/raw/prerequisites/frozen-platform-runtime-and-boundary-tests.tar.gz
cp artifacts/autonomous-brain/active-confirmation-20260926/raw/prerequisites/robot-checkpoint-clock.test.js workspaces/guangyang-platform/projects/car-python/tests/robot-checkpoint-clock.test.js
python3 - <<'PY'
import hashlib,json
from pathlib import Path
r=Path('artifacts/autonomous-brain/active-confirmation-20260926')
m=json.loads((r/'PLATFORM_RESTORE.json').read_text())
for name,expected in m['files'].items():
 p=Path(name)
 assert hashlib.sha256(p.read_bytes()).hexdigest()==expected,str(p)
for item in m['supplemental_files']:
 p=Path(item['restore_path'])
 assert p.stat().st_size==item['bytes'] and hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256'],str(p)
print('All 61 restored platform files match their original bytes.')
PY
```

平台源码commit来源为 `54b36f82109836226cf654e9a676ddf0c3b07cd0`；恢复子包不包含嵌套`.git`，不能把父仓库HEAD当成平台revision，也不伪造Git元数据。上面的逐文件检查是外部便携入口；旧 `verify_brain_revision_inputs.py` 依赖原机器的嵌套checkout和历史隔离目录，不适合作为本包的新目录入口。

实际WM目录 `vendor/wm_kit_opt2` 的50项Git文件由冻结源码checkout恢复。`FROZEN_INPUTS.json` 的 `worldModel.files` 记录实际 `world_model` 包14项源文件，`loaded_modules` 记录14个已加载模块；其 `source_tree_sha256` 是这14项包源字典的聚合哈希，不是整个50项vendor目录的哈希。不要自动升级依赖。

## 分层复算

- **函数/合成联动**：见 `TEST_COMMANDS.md`，包括原始红例和1448/29/15最终联合门。`tools/diagnose_confirmation_sampling.py --output <new-json>` 不调用模型或仿真，输出真实Perception与动作反馈的16个固定场景。成功、安全拒绝、未知回执分别记录。
- **模型文字回放**：`tools/replay_brain_llm.py --input <trial> --out <new-directory>` 保留每条记录的原契约版本、prompt、状态和响应，不执行物理动作。
- **本轮独立验收**：`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/active-confirmation-20260926/raw/formal-stage1/map-05-run-1 --out <new-evaluation-directory>`，只读冻结局，不重新仿真。结果退出码与范围见本轮 `REPORT.md`。
- **上一局公开发现链**：两个入口脚本在 `scripts/`，需要恢复上一局的公开brain输入；见 `TEST_COMMANDS.md` 的 `--brain-dir/--output` 命令。新结果不能覆盖原输出。

原始brain、完整模型调用、观测、motion、record及capture均只保存在Release包；Git只有摘要、脚本、哈希与恢复入口。无需模型密钥即可运行上述离线复算。不要为了复核结果再次启动正式驱动。

## 历史证据独立保留

- 历史d1538f7阶段1 PASS：[原Release](https://github.com/54dK3n/wm_bench/releases/tag/stage1-known-two-20260926-d1538f7)。原全局2 match / 2 unverifiable与前缀4 match不改写。
- 1117336候选阶段1 FAIL：[恢复闭环轮Release](https://github.com/54dK3n/wm_bench/releases/tag/recovery-closure-20260926-1117336)。315985482字节原包SHA256：`4f2469b497edadcf413ab29830c8e506363a6b77746a73377162ae4f861b75c2`。
- 更早阶段2前置停止：[原Release](https://github.com/54dK3n/wm_bench/releases/tag/stage2-offline-stop-20260926-ba9edd3)。

本包不重复装入上述历史大包；各自的原恢复说明与逐文件哈希继续有效。
