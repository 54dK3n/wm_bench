# 本轮证据恢复与真实入口

本轮已真实运行两局一球开发 demo，均未完成；双球阶段 1 NOT_RUN。恢复日志、复算计数不需要模型密钥或新仿真。原日志仅在 [本轮 Release](https://github.com/54dK3n/wm_bench/releases/tag/octos-live-demo-20260927-c351695)，原始 PNG 关键帧也在包内；单独附件 `smoke02-frame202.png` 便于直接查看，未叠加或改写像素。

在新空目录下载 Release 的 `DELIVERY.json`、其中 `archive` 指定的压缩包及同名 `.sha256` 校验文件。原文件清单为 `SHA256SUMS`；容器哈希在同名 `.sha256` 与 `DELIVERY.json` 中，敏感内容检查为 `SECRET_SCAN.json`。不要覆盖已有审阅目录：

```sh
DEMO_ARCHIVE=$(python3 -c 'import json; print(json.load(open("DELIVERY.json"))["archive"])')
shasum -a 256 -c "$DEMO_ARCHIVE.sha256"
mkdir evidence
tar -xzf "$DEMO_ARCHIVE" -C evidence
(cd evidence && shasum -a 256 -c artifacts/autonomous-brain/octos-live-demo-20260927/SHA256SUMS)
python3 evidence/artifacts/autonomous-brain/octos-live-demo-20260927/scripts/summarize_demo.py \
  --round-dir evidence/artifacts/autonomous-brain/octos-live-demo-20260927 \
  --out metrics-recomputed.json
cmp metrics-recomputed.json evidence/artifacts/autonomous-brain/octos-live-demo-20260927/METRICS.json
```

计数脚本只读取列明的日志和既有独立评测，输出每个输入的 SHA256，且拒绝覆盖；不重新评分。`llm.lifecycle.jsonl` 的 started/finished、完整 `llm.jsonl`、合法动作数与完整轮数分别统计。`bridge-calls.jsonl` 的 observe 数与 WM `observations.jsonl` 数不强行补齐。原评测 FAIL、尾部未消费导致的严格回放 FAIL、原 summary 默认 reason 和外部开发停止请求全部保留。

每局的 `rounds.jsonl.orchestration` 给出 `run_id/step_id`、模型调用范围、`state_ref/world_model_state_sha256`、前后观测序号、Executor dispatch、桥 request 序号和 Judge依据；相应完整行位于同局 `llm.jsonl`、`bridge-calls.jsonl`、`observations.jsonl`。`METRICS.json.platform_run_id` 直接取该局 `envelope.json.management.runId`，并列编排UUID；早先关键帧 INDEX 的 `platform_run_id=null` 原字段不改写。两局来源和输入哈希分别保存，不能拼接成一条成功搬运链。

## 源码与依赖

在上述审阅目录另建源码 checkout；不要在用户工作区回退：

```sh
git clone --no-checkout https://github.com/54dK3n/wm_bench.git source
git -C source checkout --detach c351695f8c878e0923159d6be60d293d3c77979b
mkdir -p source/workspaces
git clone https://github.com/54dK3n/octos_robots.git source/workspaces/octos_robots
git -C source/workspaces/octos_robots checkout --detach 33af31baefc9b3beaa855f33849d52254aaa8c4b
```

首局源码为 `6838a78c79af04d2e840c4a9d383924d63ef7644`，如需检查其原行为，应另建该提交的 checkout。第二局源码仅增加真实失败反馈，不能冒充首局源码。两局实际源文件哈希和依赖都在各自 `raw/smoke-*/manifest.json` 与 `summary.json.sourceManifestAfterRun`。

**本轮压缩包不包含平台依赖包。** 平台与 WorldModel 复用[上一轮 Release](https://github.com/54dK3n/wm_bench/releases/tag/grab-sampling-contract-20260927-4fa8916) 的[冻结平台与WorldModel恢复指南](https://github.com/54dK3n/wm_bench/blob/3029e7184c267014fadb4eb55d562a9c501cdb4f/artifacts/autonomous-brain/grab-sampling-contract-20260927/RESTORE.md#冻结平台与-worldmodel)。按指南单独下载旧包，校验后把其平台文件恢复到本次 `source/workspaces/guangyang-platform/projects/car-python`，不要用旧主仓 checkout 覆盖本次 c351695。平台子包 SHA256 为 `bbce700c72de792084e1a6cea5b597bc21f9c8e5338dc857d0b080e197376d08`；WorldModel 由本次源码内 `vendor/wm_kit_opt2` 恢复。两者实际哈希以本轮 manifest 为准。

运行环境使用 Node 26.7.0、Python 3.9.6 和 Chromium 浏览器；浏览器可经 `CHENLONG_BROWSER_PATH` 指定。既有平台预检诊断原件随 Git 源码恢复，不需要重跑诊断。凭据保留在本机忽略的 `.env.local`，driver 自动读取；本包不提供或要求公开任何密钥。已配置的服务为 `https://api.deepseek.com/v1`、`deepseek-flash`、temperature=0、thinking=disabled，不自动换模型或端点。

## 真实启动与独立一球判定

以下是本轮已存在、实际运行过的程序入口，会启动真实比赛平台并产生真实模型请求。这里给出新的输出目录供明确选择运行的人使用；本轮已停止，不把此命令当作离线证据复核：

```sh
cd source
node tools/autonomous_brain_driver.js --maps map-05 --runs 1 \
  --platform-root workspaces/guangyang-platform/projects/car-python \
  --orchestrator-root workspaces/octos_robots \
  --task '把一个红球送到绿色存放区' \
  --out artifacts/autonomous-brain/octos-live-demo-20260927/raw/reviewer-one-ball-new
python3 tools/evaluate_one_ball_smoke.py \
  --input artifacts/autonomous-brain/octos-live-demo-20260927/raw/reviewer-one-ball-new/map-05-run-1 \
  --out artifacts/autonomous-brain/octos-live-demo-20260927/raw/reviewer-one-ball-new-evaluation
```

driver 的原双球真值判据保持不变，因此一球需读取独立 `evaluate_one_ball_smoke.py` 结果，不能把 driver exit code 代替一球验收。原双球任务可使用同一入口与指令“把两个红球送到绿色存放区”，再用 `tools/evaluate_autonomous_brain.py`；本轮没有执行它。单局上限仍为 200 轮/1200 仿真秒，目录存在即拒绝复用。阶段 2、十布局、真机均未启动。

已有两局的一球独立评测原结果分别在 `raw/smoke-01-evaluation/` 和 `raw/smoke-02-evaluation/`。如需重新评分，分别使用该局冻结源码及 `tools/evaluate_one_ball_smoke.py --input <恢复的原局/map-05-run-1> --out <新的目录>`；这是离线消费者，不访问模型或平台。不要修改原结果来消除中断尾部的失败。
