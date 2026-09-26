# 阶段 1 证据附件恢复与只读复核

本交付仅同步提交、归档原件及补充复核入口。没有再次运行仿真、调用模型、修改冻结源码、改变原结果或启动阶段 2。

冻结源码：`d1538f7570a42b760ad518f133eaefd7bcac83a8`。原报告：`4a48664eecd3f46984f9ca48674aefe53fd9518d`。Release 标签 `stage1-known-two-20260926-d1538f7` 精确指向原报告提交。

附件 `wm-bench-stage1-20260926-evidence.tar.gz` 保存原 `SHA256SUMS` 列出的全部 79 个文件和原清单本身，文件内容逐字节保留；另含本次恢复说明、敏感信息检查结果与三个复核入口。原报告的“尚未外部上传”是当时状态，原文件保持不变，后续归档状态由本交付目录与 Release 页面说明。

## 下载、校验和恢复

从 Release 页面下载证据包及 `wm-bench-stage1-20260926-evidence.tar.gz.sha256` 到同一目录，先执行：

```sh
shasum -a 256 -c wm-bench-stage1-20260926-evidence.tar.gz.sha256
git clone --branch codex/autonomous-brain --single-branch https://github.com/54dK3n/wm_bench.git wm-bench-review
cd wm-bench-review
git checkout --detach 4a48664eecd3f46984f9ca48674aefe53fd9518d
tar -tzf ../wm-bench-stage1-20260926-evidence.tar.gz
tar -xzf ../wm-bench-stage1-20260926-evidence.tar.gz
shasum -a 256 -c artifacts/autonomous-brain/stage1-review-20260926/SHA256SUMS
```

请在新 clone 或空目录中恢复，不覆盖其他实验的证据。压缩包没有 `.env.local`、Git 配置、浏览器数据或账户凭据。原 manifest 内记录的运行机器绝对路径只是历史来源字符串，无需改写；以下评测从恢复后的相对输入路径读取。

## 只读复算，不运行仿真

使用 Python 3.9 或更新版本。所有输出指定不存在的新路径；不执行 driver 或 Runtime。原全局评测与前缀诊断分别保留。

```sh
python3 tools/evaluate_autonomous_brain.py \
  --input artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --out review-output-global

python3 tools/replay_brain_llm.py \
  --input artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --out review-output-llm

python3 artifacts/autonomous-brain/stage1-review-20260926/verify_exports.py \
  --input artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --out review-output-exports.json

PYTHONPATH=vendor/wm_kit_opt2 python3 artifacts/autonomous-brain/stage1-review-20260926/audit_action_prefix.py \
  --run-dir artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --evaluation artifacts/autonomous-brain/stage1-review-20260926/raw/formal-evaluation/evaluation.json \
  --evaluator tools/evaluate_autonomous_brain.py \
  --out review-output-prefix.json \
  --summary-out review-output-prefix-summary.json
```

预期原全局 Judge 为 2 match / 2 unverifiable；前缀诊断覆盖全部四次抓放，4 match；两次同帧见证重算与原记录一致。详细输入边界、r102 换位和 frame 590 的证据索引见 `artifacts/autonomous-brain/stage1-review-20260926/REVIEWER_ENTRYPOINTS.md`。

原 `raw/frozen-runtime-source.tar.gz` 可另解压到空目录恢复冻结运行时源码。完整 Git 仓库还提供评测、回放和复核脚本；只读复核不需要模型密钥或运行中的仿真平台。平台来源提交为 `54b36f82109836226cf654e9a676ddf0c3b07cd0`，WorldModel 的文件哈希见原 `SOURCE_PROVENANCE.json`。
