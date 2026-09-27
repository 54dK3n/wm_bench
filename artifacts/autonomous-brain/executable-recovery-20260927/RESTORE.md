# 恢复本轮证据

冻结源码：`a847a3c538c2787864633753b74dd906098ff6fd`。本轮 Release 标签为 `executable-recovery-20260927-a847a3c`，发布入口：[本轮 Release](https://github.com/54dK3n/wm_bench/releases/tag/executable-recovery-20260927-a847a3c)。正式结果与停止原因以本轮 `REPORT.md`、`METRICS.json` 和原始日志为准；本文只说明恢复，不预先判断结果。

发布完成后下载三个独立资产：

- `wm-bench-executable-recovery-20260927-evidence.tar.gz`
- `wm-bench-executable-recovery-20260927-evidence.tar.gz.sha256`
- `DELIVERY.json`

`DELIVERY.json` 保存包 SHA256、字节数、成员数和逐原件一致性；容器不能包含自己的最终哈希，因此它和容器校验文件单独发布。发布后的匿名完整下载复核另存 `PUBLICATION_VERIFICATION.json`，也不装入被它验证的包。

## 新目录恢复

将上述资产放在一个新的空审阅目录。原证据与冻结代码分别放置，避免覆盖旧验收目录或改写历史日志：

```sh
shasum -a 256 -c wm-bench-executable-recovery-20260927-evidence.tar.gz.sha256
mkdir evidence
cd evidence
tar -xzf ../wm-bench-executable-recovery-20260927-evidence.tar.gz
shasum -a 256 -c artifacts/autonomous-brain/executable-recovery-20260927/SHA256SUMS
cd ..
git clone --no-checkout https://github.com/54dK3n/wm_bench.git source
git -C source checkout --detach a847a3c538c2787864633753b74dd906098ff6fd
cd source
```

外层包只包含仓库相对路径的普通文件：无绝对路径、`..`、符号链接、硬链接和重复成员。完整报告、脚本、原始模型调用、brain 观测与 motion、独立验收原件均保留原字节。报告提交可晚于冻结代码，报告以包内实际交付版本为准。

`SHA256SUMS` 覆盖本轮目录全部原始普通文件，包括 `raw/`、报告和脚本。它自己及 `SECRET_SCAN_RAW.json`、`SECRET_SCAN.json` 作为三个额外元数据成员装入包；这些元数据的哈希由独立 `DELIVERY.json` 约束。`raw/delivery/**`、顶层 `DELIVERY.json`、精确容器校验文件 `wm-bench-executable-recovery-20260927-evidence.tar.gz.sha256` 与 `PUBLICATION*` 是生成的容器/发布元数据，排除以避免自引用。没有按文件后缀筛掉普通 raw 原件。

## 冻结平台与 WorldModel

`PLATFORM_RESTORE.json` 指向复用的平台子包 `raw/prerequisites/frozen-platform-runtime-and-boundary-tests.tar.gz`。它的 SHA256 是 `bbce700c72de792084e1a6cea5b597bc21f9c8e5338dc857d0b080e197376d08`，大小 15511914 字节，共60个普通文件；另有原字节的 `robot-checkpoint-clock.test.js` 补充文件，合计61项。平台来源 commit 为 `54b36f82109836226cf654e9a676ddf0c3b07cd0`。

在上面 `source/` 目录内执行以下便携恢复。它校验子包和每个成员，只创建缺失文件，已有文件若字节不同则停止；不会覆盖现有平台源码：

```sh
python3 - <<'PY'
import hashlib, json, tarfile
from pathlib import Path, PurePosixPath
r = Path('../evidence/artifacts/autonomous-brain/executable-recovery-20260927')
m = json.loads((r / 'PLATFORM_RESTORE.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
archive = r / m['archive']
assert archive.stat().st_size == m['archive_bytes']
assert sha(archive.read_bytes()) == m['archive_sha256']
payload = {}
with tarfile.open(archive, 'r:gz') as t:
    members = t.getmembers()
    assert len(members) == m['members'] == 60
    for item in members:
        p = PurePosixPath(item.name)
        assert item.isreg() and not item.linkname
        assert not p.is_absolute() and '..' not in p.parts and p.as_posix() == item.name
        assert item.name in m['files'] and item.name not in payload
        data = t.extractfile(item).read()
        assert sha(data) == m['files'][item.name]
        payload[item.name] = data
assert set(payload) == set(m['files'])
for item in m['supplemental_files']:
    data = (r / item['file']).read_bytes()
    assert len(data) == item['bytes'] and sha(data) == item['sha256']
    assert item['restore_path'] not in payload
    payload[item['restore_path']] = data
for name, data in payload.items():
    p = Path(name)
    assert not p.is_absolute() and '..' not in p.parts
    assert all(not q.is_symlink() for q in (p, *p.parents))
    if p.exists():
        assert p.is_file() and p.read_bytes() == data, name
    else:
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open('xb') as f: f.write(data)
    assert sha(p.read_bytes()) == sha(data), name
assert len(payload) == 61
print('All 61 platform files match their preserved original bytes.')
PY
```

平台子包不含嵌套 `.git`；不要把父仓库 HEAD 当成平台 revision，也不要伪造 Git 元数据。原机器上的平台 checkout 检查脚本不适合作为新目录入口，上面的逐项字节校验才是便携验证。

`vendor/wm_kit_opt2` 的50项 Git 文件由冻结代码 checkout 恢复，无需额外 WM 大包或依赖升级。本轮 `FROZEN_INPUTS.json` 的 `source_manifest.worldModel.files` 保存实际 `world_model` 包14项源文件哈希；`loaded_modules` 保存实际14个已加载模块。`source_tree_sha256` 是这14项源字典的聚合哈希，不能解释为整个50项 vendor 目录的哈希。可从 `source/` 再核对实际包：

```sh
python3 - <<'PY'
import hashlib, json
from pathlib import Path
r = Path('../evidence/artifacts/autonomous-brain/executable-recovery-20260927')
m = json.loads((r / 'FROZEN_INPUTS.json').read_text())
assert m['source_commit'] == 'a847a3c538c2787864633753b74dd906098ff6fd'
for name, digest in m['source_manifest']['worldModel']['files'].items():
    p = Path('vendor/wm_kit_opt2') / name
    assert hashlib.sha256(p.read_bytes()).hexdigest() == digest, name
print('Loaded WorldModel source hashes match.')
PY
```

## 离线复算，不能重跑正式局

以下命令均从 `source/` 执行，输出必须是新文件或新目录。它们不调用模型或启动仿真；不需要模型密钥。

```sh
# 本轮真实 Perception/WM 的合成部件链；--repo 核对实际导入源码与 AST。
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/diagnose_executable_recovery.py --repo . --output ../new-component.json

# 新采样视点比较及有界恢复：完整原公开框、odom、motion 和有效 hit 链。
PYTHONDONTWRITEBYTECODE=1 python3 ../evidence/artifacts/autonomous-brain/executable-recovery-20260927/scripts/probe_sampling_viewpoints.py --repo . --output ../new-viewpoints.json

# 原16个固定采样场景的新复算，不覆盖此前导出。
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/diagnose_confirmation_sampling.py --output ../new-prior-sampling.json

# 严格回放冻结局的原模型文字/版本，不请求模型，也不执行物理动作。
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/replay_brain_llm.py --input ../evidence/artifacts/autonomous-brain/executable-recovery-20260927/raw/formal-stage1/map-05-run-1 --out ../new-llm-replay

# 对已经导出的冻结局独立验收；这是离线读取，不能据此发新动作。
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/evaluate_autonomous_brain.py --input ../evidence/artifacts/autonomous-brain/executable-recovery-20260927/raw/formal-stage1/map-05-run-1 --out ../new-evaluation
```

函数、合成部件、native 局部和正式任务四层结果分开查看。测试原命令与计数见 `TEST_COMMANDS.md`、`TESTS.json`、`GATE.json`；开发中红测、版本升级前导出和最终冻结导出都保留，最终来源以 `FROZEN_INPUTS.json` 和最终门的哈希为准。native 局部记录只能证明其实际覆盖的动作，不自动证明完整采样可见性或任务通过。不要执行 `autonomous_brain_driver` 或 native 平台诊断工具来“复核”已有正式结果。

## 发布维护者的封包步骤

仅在正式局和所有原始导出完整、报告与脚本定稿后，从原仓库根执行。执行顺序不可交换，任何已有输出都不会被覆盖：

```sh
python3 artifacts/autonomous-brain/executable-recovery-20260927/scripts/package_evidence.py manifest --repo .
python3 artifacts/autonomous-brain/executable-recovery-20260927/scripts/scan_release_payload.py --repo . --manifest artifacts/autonomous-brain/executable-recovery-20260927/SHA256SUMS --env .env.local --out artifacts/autonomous-brain/executable-recovery-20260927/SECRET_SCAN_RAW.json
# 到此先独立逐项复核，另建 SECRET_SCAN.json；不能修改原扫描输出或原日志。
# 只有显式人工分类通过，且绑定同一manifest和raw扫描哈希后，才可执行：
python3 artifacts/autonomous-brain/executable-recovery-20260927/scripts/package_evidence.py pack --repo .
```

扫描入口复用 Git 中保留的 `artifacts/autonomous-brain/stage1-delivery-20260926/scan_evidence.py`，增加 ZIP 嵌套成员读取。原始报告可能因明确的源码表达式、占位符或合成测试参数退出2；必须保存原报告，逐项按原文件/嵌套成员复核，而不能删项让它通过。真实敏感内容命中时不得封包；不要把真实值或其哈希写入人工分类。

`SECRET_SCAN.json` 沿用 `reviewed-release-evidence-scan/v1`：记录 `status`、`manifest_sha256`、`raw_scan_sha256`、`all_original_sha256_match=true`、`actual_local_sensitive_value_matches=0`、`unresolved_sensitive_findings=0`、`original_evidence_modified=false` 和独立 `review_basis`。`reviewed_findings` 必须逐项对应原报告的 `file/rule/line/field`，每项包含 `review_disposition=non_sensitive_verified`、不泄露值的 `review_reason`，以及对应 `expanded_scan_units` 的 `reviewed_unit_sha256`。实际敏感环境值匹配不得人工豁免。扫描报告、人工分类与清单都入包；封包时再次核验完整目录、逐原件哈希、所有解压成员及原件未变。

生成的压缩包位于 `raw/delivery/`；同名 `.sha256` 与 `DELIVERY.json` 位于本轮目录顶层，容器校验文件可由 Git 保留。脚本不上传。若封包中断，残留输出不能冒充完成交付；先确认失败原因，再选择新的人工处理流程，脚本不会覆盖或删除它们。扫描有格式局限，人工分类通过不是任意未知秘密绝不存在的证明。

## 历史 Release 独立保留

本轮只复用约15MB的平台子包和 clock 原件，不重复装入历史大型证据包。历史原报告、原真值对照和原字节均不改写：

- [上一轮 active-confirmation](https://github.com/54dK3n/wm_bench/releases/tag/active-confirmation-20260926-dec5b07)：原包 SHA256 `ba56e5d6d81a4ff124a63f6c809cad787e0b10ee169d23fa079061517afb4056`，286570927字节；需要旧公开采样链时单独恢复。
- [recovery-closure 1117336](https://github.com/54dK3n/wm_bench/releases/tag/recovery-closure-20260926-1117336)：原包 SHA256 `4f2469b497edadcf413ab29830c8e506363a6b77746a73377162ae4f861b75c2`，315985482字节。
- [历史已知两球 d1538f7](https://github.com/54dK3n/wm_bench/releases/tag/stage1-known-two-20260926-d1538f7)：保持原结果和原验收口径。
- [历史阶段2前置停止](https://github.com/54dK3n/wm_bench/releases/tag/stage2-offline-stop-20260926-ba9edd3)。

各历史 Release 的校验清单和恢复说明仍独立有效；本轮结果不能改写或替代它们。
