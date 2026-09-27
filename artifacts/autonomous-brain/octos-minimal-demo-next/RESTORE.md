# 恢复本轮真实一球 PASS 证据

本轮仅一局真实一球搬运，独立结果 PASS；原双球阶段 1 NOT_RUN。原始字节保留在 [Release](https://github.com/54dK3n/wm_bench/releases/tag/octos-one-ball-pass-20260927-2adc8ae)，包含平台 record、完整模型/桥/观测日志、独立评测和原始关键帧。`delivered-frame350.png` 另作附件便于直接查看。恢复和下列计数不需要密钥或新仿真。

在新空目录下载 Release 的 `DELIVERY.json`、其中 `archive` 指定的压缩包及同名 `.sha256`；不要覆盖已有审阅目录。容器哈希在 `.sha256` 和 `DELIVERY.json`，原文件哈希在 `SHA256SUMS`，敏感内容检查在 `SECRET_SCAN.json`。

```sh
DEMO_ARCHIVE=$(python3 -c 'import json; print(json.load(open("DELIVERY.json"))["archive"])')
shasum -a 256 -c "$DEMO_ARCHIVE.sha256"
mkdir evidence
tar -xzf "$DEMO_ARCHIVE" -C evidence
(cd evidence && shasum -a 256 -c artifacts/autonomous-brain/octos-minimal-demo-next/SHA256SUMS)
python3 evidence/artifacts/autonomous-brain/octos-minimal-demo-next/scripts/summarize_demo.py \
  --round-dir evidence/artifacts/autonomous-brain/octos-minimal-demo-next \
  --out metrics-recomputed.json
cmp metrics-recomputed.json evidence/artifacts/autonomous-brain/octos-minimal-demo-next/METRICS.json
```

脚本 create-only，纯读原日志和已完成独立评测，不重新评分。它分别统计 lifecycle started/finished、完整 LLM 行、完整决策轮、WM 观测、桥请求和成功证据，记录每个输入 SHA256，拒绝读取期间变化的输入。`raw/smoke-01/map-05-run-1/brain/rounds.jsonl.orchestration` 把同一 `run_id/step_id` 下模型调用、WM 状态哈希、前后观测序号、Executor dispatch、桥请求序号及 Judge 串联；对照同目录 `llm.jsonl`、`bridge-calls.jsonl`、`observations.jsonl`。平台原生 run ID 从 `envelope.json.management.runId` 引用。

## 源码和既有平台依赖

在审阅目录另建 checkout，不回退用户工作区：

```sh
git clone --no-checkout https://github.com/54dK3n/wm_bench.git source
git -C source checkout --detach 2adc8aecc085c2f99f14131f1f2c10e7b109021e
mkdir -p source/workspaces
git clone https://github.com/54dK3n/octos_robots.git source/workspaces/octos_robots
git -C source/workspaces/octos_robots checkout --detach 33af31baefc9b3beaa855f33849d52254aaa8c4b
```

实际调用框架无关 `orchestrator.executor.Executor`，没有外部 Octos runtime。冻结依赖与运行前后文件哈希见包内 `raw/smoke-01/manifest.json` 和 `summary.json.sourceManifestAfterRun`。

**本轮包不含平台依赖包。** 按[既有冻结平台与 WorldModel 恢复指南](https://github.com/54dK3n/wm_bench/blob/3029e7184c267014fadb4eb55d562a9c501cdb4f/artifacts/autonomous-brain/grab-sampling-contract-20260927/RESTORE.md#冻结平台与-worldmodel)，从[依赖 Release](https://github.com/54dK3n/wm_bench/releases/tag/grab-sampling-contract-20260927-4fa8916) 单独下载旧包，将平台文件恢复至 `source/workspaces/guangyang-platform/projects/car-python`。平台子包 SHA256 为 `bbce700c72de792084e1a6cea5b597bc21f9c8e5338dc857d0b080e197376d08`；不要以旧主仓覆盖本次源码。WorldModel 使用本次源码内 `vendor/wm_kit_opt2`，实际依赖哈希以本轮 manifest 为准。

环境为 Node 26.7.0、Python 3.9.6、Chromium；浏览器可用 `CHENLONG_BROWSER_PATH` 指定。真实运行自动使用本机忽略的 `.env.local` 加载既有凭据；包内没有密钥或账户数据。服务为 `https://api.deepseek.com/v1` / `deepseek-flash` / temperature=0 / thinking=disabled，不自动更换模型或端点。

## 已有评测复核与真实启动

原独立一球评测在 `evidence/artifacts/autonomous-brain/octos-minimal-demo-next/raw/smoke-01-evaluation/evaluation.json`。如需重新计算，只在新输出目录执行以下离线消费者；它不访问模型服务或比赛平台。必须提供 WM 导入路径，原先缺少该路径的失败 stderr 和后续配置正确的 stderr 均保留，前者不算评测结果。

```sh
cd source
PYTHONPATH=vendor/wm_kit_opt2:. python3 tools/evaluate_one_ball_smoke.py \
  --input ../evidence/artifacts/autonomous-brain/octos-minimal-demo-next/raw/smoke-01/map-05-run-1 \
  --out ../one-ball-evaluation-recomputed
```

以下是真实平台与 LLM 启动入口，会产生新模型请求；本轮已停止，不作为离线复核步骤自动执行：

```sh
node tools/autonomous_brain_driver.js --maps map-05 --runs 1 \
  --platform-root workspaces/guangyang-platform/projects/car-python \
  --orchestrator-root workspaces/octos_robots \
  --task '把一个红球送到绿色存放区' \
  --out artifacts/autonomous-brain/octos-minimal-demo-next/raw/reviewer-one-ball-new
PYTHONPATH=vendor/wm_kit_opt2:. python3 tools/evaluate_one_ball_smoke.py \
  --input artifacts/autonomous-brain/octos-minimal-demo-next/raw/reviewer-one-ball-new/map-05-run-1 \
  --out artifacts/autonomous-brain/octos-minimal-demo-next/raw/reviewer-one-ball-new-evaluation
```

原 driver 固定双球判据保持 `false`，与独立一球 PASS 并列保存；driver 退出码不能代替一球评测。两球指令和原阶段 1 必须单独运行、单独验收，本轮未运行。单局上限 200 轮/1200 仿真秒不变，不复用已有输出目录，不拼接旧局成绩。
