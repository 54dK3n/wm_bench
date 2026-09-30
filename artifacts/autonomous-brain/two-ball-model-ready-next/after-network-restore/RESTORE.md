# 本轮原件恢复与复算

附件只包含连接恢复后的检查、两局独立比赛和本次小修验证；不重复打包全部历史。原连接阻断快照保持在上级REPORT和其原Release中。

下载同一[Release](https://github.com/54dK3n/wm_bench/releases/tag/two-ball-model-ready-20260930-75fe359)的压缩包及 `.sha256`，在下载目录校验压缩包，然后解压到**新空目录**。进入该目录运行：

```sh
shasum -a 256 -c wm-bench-two-ball-model-ready-20260930.tar.gz.sha256
mkdir restored-two-ball-model-ready
tar -xzf wm-bench-two-ball-model-ready-20260930.tar.gz -C restored-two-ball-model-ready
cd restored-two-ball-model-ready
shasum -a 256 -c artifacts/autonomous-brain/two-ball-model-ready-next/after-network-restore/SHA256SUMS
```

SHA256SUMS逐文件校验原件；DELIVERY.json记录包哈希、成员及扫描状态。原日志、stderr、退出码和物理gzip均不改写。首局36原文件亦与运行结束即保存的独立哈希清单逐字节一致。

本次实际执行的网络入口（目录已有结果，**不要覆盖或将下列诊断再次计为本轮请求**）：

```sh
node artifacts/autonomous-brain/two-ball-model-ready-next/scripts/check_model.js network artifacts/autonomous-brain/two-ball-model-ready-next/raw/network-02
node artifacts/autonomous-brain/two-ball-model-ready-next/scripts/check_model.js smoke artifacts/autonomous-brain/two-ball-model-ready-next/raw/smoke-01
```

两局均执行以下真实入口，OUT分别为 `artifacts/autonomous-brain/two-ball-model-ready-next/run-20260930T214331` 和 `artifacts/autonomous-brain/two-ball-model-ready-next/run-20260930T221441`。原 `.stdout.txt`、`.stderr.txt`、`.evaluator.stdout.txt`、`.evaluator.stderr.txt`、`.source.txt`、`.exits.txt` 与运行目录同前缀保存；未用 `&&` 跳过失败局评测。

```sh
DRIVER_EXIT=0
node tools/autonomous_brain_driver.js --maps map-05 --runs 1 \
  --platform-root workspaces/guangyang-platform/projects/car-python \
  --orchestrator-root workspaces/octos_robots \
  --task '把两个红球送到绿色存放区' --out "$OUT" \
  > "$OUT.stdout.txt" 2> "$OUT.stderr.txt" || DRIVER_EXIT=$?
EVALUATOR_EXIT=0
PY="${BRAIN_PYTHON:-python3}"
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 "$PY" \
  tools/evaluate_autonomous_brain.py --input "$OUT/map-05-run-1" \
  --out "$OUT-evaluation" > "$OUT.evaluator.stdout.txt" \
  2> "$OUT.evaluator.stderr.txt" || EVALUATOR_EXIT=$?
printf 'driver_exit=%s\nevaluator_exit=%s\n' "$DRIVER_EXIT" "$EVALUATOR_EXIT"
```

复算只需离线评测，不运行driver、不调用模型或执行器。在对应源码的独立checkout（第一局3aaa2f3，第二局75fe359）中恢复归档，保留原输出，换用新的评测目录：

```sh
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 python3 \
  tools/evaluate_autonomous_brain.py --input "$OUT/map-05-run-1" \
  --out "$OUT-review-evaluation"
python3 artifacts/autonomous-brain/two-ball-transport-next/scripts/summarize_run.py \
  --run-dir "$OUT/map-05-run-1" --out "$OUT-review-public-counts.json"
```

两局没有当局源码tar。源码按已推送的主仓冻结commit恢复（第一局 `3aaa2f3509d9c5ebb0725d9ef40324f813886af8`，第二局 `75fe35955269f5a1afc4f4da7cd5d349a9977a41`），平台按 `54b36f82109836226cf654e9a676ddf0c3b07cd0`、Executor按 `33af31baefc9b3beaa855f33849d52254aaa8c4b` 恢复，再逐文件核对各局manifest与FROZEN_INPUTS。评测需要原vendor路径；实际WM源树与加载哈希亦在manifest中，不把其历史上游标签当作当前文件未改的证明。真值仅供该离线评测，不能把record/evaluator输出回流给脑端。

针对性测试命令与全部原输出路径见METRICS的tests，以及归档 `raw/checks/test-command-summary.json`。本次新测试为 `tests/test_brain_blocked_explore_return.py`；旧4项失败的原源码对照命令一并保留。运行中监控测试没有重跑，未声称其分支在本局触发。
