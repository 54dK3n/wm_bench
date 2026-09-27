# 一球回归证据恢复与复算

本轮 `one-ball-regression-20260927T222206` 独立一球 PASS，原双球阶段 1 NOT_RUN。原始日志、完整评测、旧基线离线复算和三张原始关键帧在 [Release](https://github.com/54dK3n/wm_bench/releases/tag/one-ball-review-20260927-c4bf08e)。新包为 `wm-bench-one-ball-review-20260927-evidence.tar.gz`，实际名称从 `DELIVERY.json.archive` 读取；恢复和计数无需密钥、模型请求或新仿真。

在新空目录下载 `DELIVERY.json`、指定压缩包和同名 `.sha256`。容器哈希在 `.sha256` 与 `DELIVERY.json`，原文件哈希在 `SHA256SUMS`，敏感内容检查在 `SECRET_SCAN.json`；不覆盖已有文件：

```sh
DEMO_ARCHIVE=$(python3 -c 'import json; print(json.load(open("DELIVERY.json"))["archive"])')
shasum -a 256 -c "$DEMO_ARCHIVE.sha256"
mkdir evidence
tar -xzf "$DEMO_ARCHIVE" -C evidence
(cd evidence && shasum -a 256 -c artifacts/autonomous-brain/one-ball-review-next/SHA256SUMS)
python3 evidence/artifacts/autonomous-brain/one-ball-review-next/scripts/summarize_demo.py \
  --round-dir evidence/artifacts/autonomous-brain/one-ball-review-next \
  --out metrics-recomputed.json
cmp metrics-recomputed.json evidence/artifacts/autonomous-brain/one-ball-review-next/METRICS.json
```

计数脚本沿用上一轮实现，仅适配本轮目录和已有复核结果，create-only，纯读原日志与已完成评测，不重新评分。它分别计数完整轮、LLM started/finished、pick 决策、grab 请求及有效交付，并为输入记录 SHA256；读取期间有变化即拒绝输出。`METRICS.json` 中基线复算、测试及实测分支是对既有结果的引用，不是再次运行。

## 证据对应

本局原生日志根为 `raw/one-ball-regression-20260927T222206/map-05-run-1`。`brain/rounds.jsonl.orchestration` 关联 `run_id/step_id`、WM 状态哈希、模型调用范围、Executor dispatch、桥请求和动作前后观测；对应 `llm.jsonl`、`llm.lifecycle.jsonl`、`bridge-calls.jsonl`、`observations.jsonl`。平台 run ID 为 `run-0dacc29a-ac3e-4685-a06a-393c77f336fa`，取自 `envelope.json.management.runId`。

`raw/keyframes/INDEX.json` 记录本局 record SHA256 `a83847511e7e373f759c92d67185fbe179fa424bdeb490b880dc132f4ffd60a2` 及提取来源：r37/obs157 `held-frame157.png`，r66/obs300 `delivered-frame300.png`，r67/obs311 `done-frame311.png`。像素为本局原 PNG 字节，没有编辑；交付帧另作 Release 附件。

本局独立结果位于 `raw/one-ball-regression-20260927T222206-evaluation/evaluation.json`；driver/evaluator 退出码分别 1/0，取自同名 `.exits.json`。原 driver 的固定双球 false 与两项另一球未交付失败保留，一球 PASS 不替代它。`raw/checks/recovery-exercise-review.json` 区分身份采样尝试未消解、未触发的 pick 上下文锁及未触发的 pick 离路逆归路；严格转录 PASS 也不等于全导航物理验收。

旧成功基线的复核摘要在 `raw/baseline-recompute/RESULT.json`。其原始证据仍使用[旧 Release](https://github.com/54dK3n/wm_bench/releases/tag/octos-one-ball-pass-20260927-2adc8ae)及[原恢复指南](../octos-minimal-demo-next/RESTORE.md)，本轮包不重复包含旧局全部 raw。旧包 SHA256 为 `7eb511cdbbb67ac9dc3874583dc31babbb0805d4c579b7cdd21422ce297ad194`；53 个原文件和指标原字节均未改写。检查旧行为须另取 `2adc8aecc085c2f99f14131f1f2c10e7b109021e`，不能以新源码冒充旧基线。

## 冻结源码与依赖

另建 checkout，不回退用户工作区：

```sh
git clone --no-checkout https://github.com/54dK3n/wm_bench.git source
git -C source checkout --detach c4bf08e1114363ddff3c0f5bce7cdcb1c041af27
mkdir -p source/workspaces
git clone https://github.com/54dK3n/octos_robots.git source/workspaces/octos_robots
git -C source/workspaces/octos_robots checkout --detach 33af31baefc9b3beaa855f33849d52254aaa8c4b
```

实际编排是框架无关 `orchestrator.executor.Executor`，没有外部 Octos runtime，`max_retries=0`。平台提交为 `54b36f82109836226cf654e9a676ddf0c3b07cd0`。本轮包不含平台依赖包，按[既有平台恢复指南](https://github.com/54dK3n/wm_bench/blob/3029e7184c267014fadb4eb55d562a9c501cdb4f/artifacts/autonomous-brain/grab-sampling-contract-20260927/RESTORE.md#冻结平台与-worldmodel)，从[依赖 Release](https://github.com/54dK3n/wm_bench/releases/tag/grab-sampling-contract-20260927-4fa8916) 恢复平台文件到 `source/workspaces/guangyang-platform/projects/car-python`。平台子包 SHA256 `bbce700c72de792084e1a6cea5b597bc21f9c8e5338dc857d0b080e197376d08`，不要以旧主仓覆盖本次源码。

WorldModel 是本次源码中的 `vendor/wm_kit_opt2`，实际源树 SHA256 为 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`，与上一成功局一致。上游锁 `fef0ba9` 仅表示历史来源，不表示当前 vendored 文件未修改；以本局 manifest、`raw/checks/config-and-dependencies.json` 中逐文件与已加载模块哈希为准。

Node 26.7.0、Python 3.9.6、Chromium；浏览器可通过 `CHENLONG_BROWSER_PATH` 指定。真实运行仍使用本机忽略的 `.env.local` 和既有凭据加载器，官方 `https://api.deepseek.com/v1` / `deepseek-flash` / temperature=0 / thinking=disabled。包内无密钥或账户数据。

## 已有入口

从 `source` 目录使用冻结评测器重新复核已有证据时，只能写新输出目录；该命令是离线消费者，不调用模型或仿真：

```sh
cd source
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 python3 tools/evaluate_one_ball_smoke.py \
  --input ../evidence/artifacts/autonomous-brain/one-ball-review-next/raw/one-ball-regression-20260927T222206/map-05-run-1 \
  --out ../one-ball-evaluation-recomputed
```

[REPORT.md](REPORT.md) 按 `raw/RUN.json` 列出本局实际启动和评测命令（含 PYTHONPATH），它们已运行完毕，不再执行。若以后明确批准新局，必须使用新输出目录，原 200 轮/1200 秒预算和验收条件不变。本轮没有启动双球、阶段 2、十布局或真机。
