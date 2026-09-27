# 恢复本轮证据

本轮目录为 `artifacts/autonomous-brain/grab-sampling-contract-20260927`。本轮唯一独立模型服务预检返回 HTTP402，随后停止，未启动新正式局。交付内容为源码候选、离线与合成证据及该次预检记录；不能称为新正式任务通过。冻结源码以包内 `FROZEN_INPUTS.json.source_commit` 为准；封包工具要求完整40位小写 SHA，并据此生成标签 `grab-sampling-contract-20260927-<SHA前7位>`。实际发布 URL 由独立资产 `DELIVERY.json.release_url` 给出。详细停止阶段、测试统计与结果见 `REPORT.md`、`METRICS.json`、`GATE.json` 和 `TEST_COMMANDS.md`。

本次冻结提交为 `4fa8916f8570b467983c86337a46dc5d1b900cde`，对应发布标签 `grab-sampling-contract-20260927-4fa8916`。下方恢复仍从冻结元数据读取并与容器元数据交叉核对；不能只凭标签短 SHA 选择源码。

发布后下载同一 Release 的三个资产：

- `wm-bench-grab-sampling-contract-20260927-evidence.tar.gz`
- `wm-bench-grab-sampling-contract-20260927-evidence.tar.gz.sha256`
- `DELIVERY.json`

容器校验文件和 `DELIVERY.json` 单独发布，不能装入包含自身最终哈希的容器。发布后匿名完整下载复核另存 `PUBLICATION_VERIFICATION.json`，不装入被它验证的包。

## 新目录恢复

把三个资产放入新的空审阅目录。以下步骤建立独立的 `current-evidence/` 和 `current-source/`；不要在历史恢复目录执行，不要覆盖既有输入或复算输出。

```sh
shasum -a 256 -c wm-bench-grab-sampling-contract-20260927-evidence.tar.gz.sha256
mkdir current-evidence
cd current-evidence
tar -xzf ../wm-bench-grab-sampling-contract-20260927-evidence.tar.gz
shasum -a 256 -c artifacts/autonomous-brain/grab-sampling-contract-20260927/SHA256SUMS
cd ..
python3 - <<'PY'
import hashlib, json, re
from pathlib import Path
r = Path('current-evidence/artifacts/autonomous-brain/grab-sampling-contract-20260927')
d = json.loads(Path('DELIVERY.json').read_text())
f = json.loads((r / 'FROZEN_INPUTS.json').read_text())
s = f['source_commit']
assert isinstance(s, str) and re.fullmatch(r'[0-9a-f]{40}', s)
assert d['source_commit'] == s
assert d['release_url'] == 'https://github.com/54dK3n/wm_bench/releases/tag/grab-sampling-contract-20260927-' + s[:7]
a = Path(d['archive'])
assert a.name == 'wm-bench-grab-sampling-contract-20260927-evidence.tar.gz'
assert a.stat().st_size == d['archive_bytes']
assert hashlib.sha256(a.read_bytes()).hexdigest() == d['archive_sha256']
for name, key in [('SHA256SUMS', 'sha256sums_sha256'), ('SECRET_SCAN_RAW.json', 'secret_scan_raw_sha256'), ('SECRET_SCAN.json', 'secret_scan_sha256')]:
    assert hashlib.sha256((r / name).read_bytes()).hexdigest() == d[key], name
print('Container, frozen source reference and metadata hashes agree:', s)
PY
git clone --no-checkout https://github.com/54dK3n/wm_bench.git current-source
SOURCE_COMMIT=$(python3 -c 'import json; print(json.load(open("current-evidence/artifacts/autonomous-brain/grab-sampling-contract-20260927/FROZEN_INPUTS.json"))["source_commit"])')
git -C current-source checkout --detach "$SOURCE_COMMIT"
cd current-source
```

外层包仅有安全仓库相对路径的普通文件，无绝对路径、`..`、链接和重复成员。`SHA256SUMS` 覆盖本轮目录全部原始普通文件，包括 raw、报告与脚本；它自己及两个扫描报告为额外三个元数据成员，其哈希由 `DELIVERY.json` 约束。排除项为 `raw/delivery/**`、顶层 `DELIVERY.json`、精确容器校验文件和 `PUBLICATION*`，用于避免自引用；没有按后缀筛掉普通 raw 原件。报告可能晚于冻结代码提交，报告与辅助交付脚本以包内版本为准。

## 冻结平台与 WorldModel

`PLATFORM_RESTORE.json` 指向 `raw/prerequisites/frozen-platform-runtime-and-boundary-tests.tar.gz`，子包 SHA256 为 `bbce700c72de792084e1a6cea5b597bc21f9c8e5338dc857d0b080e197376d08`，大小15511914字节，60个普通文件。另有原字节的 `robot-checkpoint-clock.test.js` 补充文件，合计61项。平台来源提交为 `54b36f82109836226cf654e9a676ddf0c3b07cd0`。本轮直接携带这些 prerequisites，不要求先下载旧大型证据包。

在 `current-source/` 内执行以下便携恢复：先核对完整子包与每项原字节，仅创建缺失文件；已有路径若内容不符则停止，绝不覆盖平台源码。

```sh
python3 - <<'PY'
import hashlib, json, tarfile
from pathlib import Path, PurePosixPath
r = Path('../current-evidence/artifacts/autonomous-brain/grab-sampling-contract-20260927')
m = json.loads((r / 'PLATFORM_RESTORE.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
a = r / m['archive']
assert a.stat().st_size == m['archive_bytes']
assert sha(a.read_bytes()) == m['archive_sha256']
payload = {}
with tarfile.open(a, 'r:gz') as t:
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
print('All 61 platform files match the preserved original bytes.')
PY
```

子包不含嵌套 `.git`。不能把父仓库 HEAD 当作平台 revision，也不应伪造平台 Git 元数据；此处按原件 SHA 核验。`vendor/wm_kit_opt2` 由冻结源码 checkout 恢复，不升级依赖。实际 WorldModel 来源以 `FROZEN_INPUTS.json.source_manifest.worldModel` 为准：`files` 为实际包源文件哈希，`loaded_modules` 为实际加载模块；其 `source_tree_sha256` 不能解释为整个 vendor 目录的哈希。

```sh
python3 - <<'PY'
import hashlib, json, subprocess
from pathlib import Path
r = Path('../current-evidence/artifacts/autonomous-brain/grab-sampling-contract-20260927')
m = json.loads((r / 'FROZEN_INPUTS.json').read_text())
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == m['source_commit']
for name, digest in m['source_manifest']['worldModel']['files'].items():
    p = Path('vendor/wm_kit_opt2') / name
    assert hashlib.sha256(p.read_bytes()).hexdigest() == digest, name
print('Frozen checkout and actual WorldModel source hashes match.')
PY
```

## 本轮离线复核入口

以下均从 `current-source/` 执行。需要 Python、可导入的 pytest 与 Node；Node 仅执行冻结 `normalizeCommand`，不启动平台仿真。输出路径必须新建；不需要模型密钥，不调用模型。完整测试命令、运行时依赖版本和最终计数以本轮测试说明及 gate 原件为准。

```sh
# 合成采样：20、10+10、5*4 支持链及真实 Perception/WM 的后退失视→前进恢复。
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:vendor/wm_kit_opt2 python3 tests/test_brain_sampling_inverse_chain.py --output ../new-sampling-inverse.json

# 合成抓取：逐次 grab 授权、重新确认及 unknown 不重发，包含独立审计。
PYTHONDONTWRITEBYTECODE=1 python3 ../current-evidence/artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/export_grab_examples.py --repo . --output ../new-grab-examples.json

# 独立消费者重新读取刚导出的公开合成链，不再次运行生产者。
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:vendor/wm_kit_opt2 python3 ../current-evidence/artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/recheck_grab_examples.py --input ../new-grab-examples.json --output ../new-grab-audit.json
```

这些入口分别导出5个采样场景和9个抓取场景，保存公开观测、实际 motion、命令与引用；它们是合成部件证据，不能当作真实平台或正式任务通过。合法拒绝场景没有非法抓放账本，其审计无失败也不代表任务完成。开发中红测、修复中间版本与最终冻结导出分别保留，不能混用源码指纹或合并为一个测试计数。

本轮最终候选原导出分别在 `raw/gate/sampling-frozen-candidate.json`（5例）和 `raw/gate/grab-frozen-candidate.json`（9例）。上面的 `new-*.json` 是复算副本，不能覆盖这两个原件。独立消费者也可将 `--input` 指向 `../current-evidence/artifacts/autonomous-brain/grab-sampling-contract-20260927/raw/gate/grab-frozen-candidate.json`，仅重新读取原九例，`--output` 仍须使用新文件。

**模型可用性预检不是离线复核步骤。** 不运行模型预检、`autonomous_brain_driver`、native 平台诊断或新正式局来验证已有结果。本轮已经因唯一预检 HTTP402 停止，没有新正式转录或正式评测入口，不应由审阅者补跑或把历史输入冒充本轮输入。

## 历史 r34 与 v19 转录单独恢复

本轮不重复装入历史大型证据包。要复算原 r34 抓放命令链及原 v19 LLM 转录，必须另外下载 [executable-recovery a847a3c Release](https://github.com/54dK3n/wm_bench/releases/tag/executable-recovery-20260927-a847a3c) 的三个原资产：

- `wm-bench-executable-recovery-20260927-evidence.tar.gz`
- `wm-bench-executable-recovery-20260927-evidence.tar.gz.sha256`
- 旧 `DELIVERY.json`（存于单独下载目录，不能替换本轮同名资产）。

把旧资产放进与 `current-evidence/` 平行的新 `historical-download/` 目录，然后从审阅根目录执行：

```sh
cd historical-download
shasum -a 256 -c wm-bench-executable-recovery-20260927-evidence.tar.gz.sha256
cd ..
mkdir historical-evidence
cd historical-evidence
tar -xzf ../historical-download/wm-bench-executable-recovery-20260927-evidence.tar.gz
shasum -a 256 -c artifacts/autonomous-brain/executable-recovery-20260927/SHA256SUMS
cd ../current-source

# 只读五份原 brain 公开日志，比较旧基线 helper 与当前 helper；不运行总评测器。
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:vendor/wm_kit_opt2 python3 ../current-evidence/artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/recheck_historical_public.py --brain-dir ../historical-evidence/artifacts/autonomous-brain/executable-recovery-20260927/raw/formal-stage1/map-05-run-1/brain --output ../new-historical-r34-audit.json

# 严格重放原模型文字及其 v19 提示版本，零模型请求、零物理动作。
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:vendor/wm_kit_opt2 python3 tools/replay_brain_llm.py --input ../historical-evidence/artifacts/autonomous-brain/executable-recovery-20260927/raw/formal-stage1/map-05-run-1 --out ../new-historical-v19-replay
```

历史 helper 比较需要 Git 中存在 `10e3c879d2499d6f893151f24857c315f12fe2e7:tools/brain_evidence_audit.py`，因此上面使用完整 clone，不使用浅克隆。原局 Runtime 声明是 v17，v19 指 LLM 转录版本；二者不同。r34 第二次 grab 前目标原状态为 STALE，原三个证据链拒绝保持。此处保存原输入前后 SHA 并在新文件输出复算，不能替换或修正旧 FAIL。若要完整重建旧执行环境，另用旧 Release 的 `RESTORE.md` 和源码 `a847a3c538c2787864633753b74dd906098ff6fd`；不要把本轮源码冒充旧源码。

## 发布维护者封包入口

以下是维护者步骤，不是审阅者复跑要求。仅在本轮授权工作结束、原始导出完整、报告与脚本定稿且 `FROZEN_INPUTS.json` 已确定后执行。此文档与工具的准备不表示已经运行任何封包、扫描或上传。

```sh
python3 artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/package_evidence.py manifest --repo .
python3 artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/scan_release_payload.py --repo . --manifest artifacts/autonomous-brain/grab-sampling-contract-20260927/SHA256SUMS --env .env.local --out artifacts/autonomous-brain/grab-sampling-contract-20260927/SECRET_SCAN_RAW.json
# 独立逐项核查原扫描单元，另建 SECRET_SCAN.json；不能删除命中或改写原扫描和原日志。
# 只有分类通过，且绑定精确清单/扫描哈希后才封包：
python3 artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/package_evidence.py pack --repo .
```

扫描入口复用仓库保留的 scanner 并扩展 ZIP 内部成员读取；真实环境敏感值仅在维护者本机内存比较，不输出秘密值或其哈希。明确的合成参数、源码表达式或占位符命中也必须先保存原扫描，再按真实单元逐项分类，不能沿用上一轮结论。真实敏感内容命中时不得封包。

`SECRET_SCAN.json` 使用 `reviewed-release-evidence-scan/v1`，包括 `status`、`manifest_sha256`、`raw_scan_sha256`、`all_original_sha256_match=true`、`actual_local_sensitive_value_matches=0`、`unresolved_sensitive_findings=0`、`original_evidence_modified=false` 和独立 `review_basis`。每个 `reviewed_findings` 必须保留原 `file/rule/line/field`，附 `review_disposition=non_sensitive_verified`、不泄露值的分类理由和对应扫描单元的 `reviewed_unit_sha256`。真实环境敏感值匹配不得豁免。

工具仅创建新输出：完整清单、逐原件哈希、扫描分类和容器解压成员都会重新核对；已有输出则拒绝覆盖。容器写入 `raw/delivery/`，同名校验文件及 `DELIVERY.json` 写入本轮顶层，脚本不上传。清单与扫描后新增普通文件会令封包失败；发布验证必须放在排除的发布元数据位置。若中断留下部分容器，不能把它当完成交付，工具也不会自行删除或覆盖。历史各 Release 与本轮始终保持独立目录、原字节和原结论。
