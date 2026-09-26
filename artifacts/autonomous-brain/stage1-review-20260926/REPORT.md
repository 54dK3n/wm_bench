# 阶段 1 正式验收报告

## 1. 结论

**PASS：阶段 1 已验收。**

本轮只执行 `map-05` 和指令“把两个红球送到绿色存放区”。同一冻结版本在原有 200 轮、1200 仿真秒上限内完成两球交付；大模型在第 111 轮主动选择 `done`，执行层在新观测后验证通过。阶段 2 的未知数量任务、全图探索、十布局和真机工作均未启动。

原正式评测文件保留其原始全局 judge：`match=2`、`unverifiable=2`。补充审计按每次动作前的全部观测前缀复算全部四次抓放，得到 4/4 match，并以原 `placement_evidence` 和 0.64 内椭圆门复核两次放置；两次选中的同帧 witness 对应不同红球，旧球没有被第二次放置重复计数。补充审计只解释歧义，不替换正式评测结果。

## 2. 版本和边界

- 大脑：`codex/autonomous-brain@d1538f7570a42b760ad518f133eaefd7bcac83a8`。
- 平台：`v4/robot-backend@54b36f82109836226cf654e9a676ddf0c3b07cd0`。
- WorldModel：`vendor/wm_kit_opt2`，源树 SHA256 为 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`；50 个锁定文件未变。
- 正式模型：DeepSeek Flash，temperature 0，thinking disabled；115 次调用均有 started/finished 记录，网络失败 0 次。
- 原始证据不进 Git，位于本目录 `raw/`；本地外部归档尚未完成，未将本地文件冒充已上传。

## 3. 本轮修复

Review A–H 的处理见 [REVIEW.md](REVIEW.md)。关键行为是：从自然语言生成已知数量任务结构；按规范身份、同帧交付 witness 和夹爪状态计数；允许未完成全图探索时完成已知数量任务；持久化导航失败并拒绝无新证据的重复动作；沿观测支持的道路候选执行有限换位；统一核验基础运动；用真实 holding 处理 pending grasp；为 `RELEASED_UNVERIFIED` 接入合法复核恢复；统一球体/障碍物尺寸语义；在首个运动命令前锁定模型和实际依赖来源。

## 4. 测试

```text
定向：94 passed, 0 failed
完整回归：1326 passed, 0 failed
Node 回归：27 passed, 0 failed
旧 Run21/Run22 离线模型回放：全部通过，网络调用 0
```

完整命令、日志和中间环境失败的处理见 [VALIDATION.json](VALIDATION.json)。

## 5. 正式 map-05 结果

- 111 轮、115 次模型调用、594 次观测、577.8 仿真秒；未触及轮数或仿真时间上限。
- 大脑任务账本：`required_count=2`、`delivered_count=2`、未解决身份 0、夹爪为空、`ready_for_done=true`。
- 独立交付评测：两个不同红球最终均在绿色存放区内且未被夹持；执行失败 0、外部停止 0、白名单外大脑请求 0。
- 21 次动作失败均有结果/恢复证据。导航审计发现 3 次重复失败请求均被零命令拒绝；一次换位候选实际走了 190.4 cm，但出口方向不唯一而停止，因此“完整候选换位成功”本局为 0，不能写成换位端到端成功。

## 6. 证据、哈希和复算

正式评测为 `raw/formal-evaluation/evaluation.json`；五项原始导出及压缩包展开 SHA256 见 [EXPORT_INTEGRITY.json](EXPORT_INTEGRITY.json)。源码、平台、WorldModel 和模型配置见 [SOURCE_PROVENANCE.json](SOURCE_PROVENANCE.json)。紧凑动作前缀审计见 [ACTION_PREFIX_AUDIT.json](ACTION_PREFIX_AUDIT.json)，逐框原件留在 `raw/action-prefix-audit.json`。

从仓库根目录可在新输出路径复算：

```sh
shasum -a 256 -c artifacts/autonomous-brain/stage1-review-20260926/SHA256SUMS
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/evaluate_autonomous_brain.py \
  --input artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --out /tmp/stage1-evaluation-recompute
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/replay_brain_llm.py \
  --input artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --out /tmp/stage1-llm-replay-recompute
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 artifacts/autonomous-brain/stage1-review-20260926/verify_exports.py \
  --input artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --out /tmp/stage1-export-integrity-recompute.json
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 artifacts/autonomous-brain/stage1-review-20260926/audit_action_prefix.py \
  --run-dir artifacts/autonomous-brain/stage1-review-20260926/raw/formal-map05/map-05-run-1 \
  --evaluation artifacts/autonomous-brain/stage1-review-20260926/raw/formal-evaluation/evaluation.json \
  --evaluator tools/evaluate_autonomous_brain.py \
  --out /tmp/action-prefix-audit-recompute.json \
  --summary-out /tmp/action-prefix-summary-recompute.json
```

冻结运行时源码可由 `raw/frozen-runtime-source.tar.gz` 解压到空目录恢复；其提交、来源和完整文件哈希仍由 Git 与 [SOURCE_PROVENANCE.json](SOURCE_PROVENANCE.json) 约束。

## 7. 未完成事项

本轮没有完成外部证据上传；交付时必须同时保留 `raw/` 原件和 [SHA256SUMS](SHA256SUMS)。frame 590 的临时已交付球标签错误仍作为已定位的残余问题记录，未在正式局中修改或隐藏；它没有造成最终交付重复计数，且已由补充审计解释。导航换位候选本局没有完整成功。阶段 2 及以后必须另行设计、测试和正式验收，不得把本轮 PASS 作为其凭证。
