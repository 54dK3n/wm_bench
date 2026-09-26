# 本轮测试命令与统计口径

以下命令均在源码仓库根目录执行。复算输出必须使用新文件或新目录。Python 为 3.9.6，Node 为 26.7.0；真实 WorldModel 文件来源见 `FROZEN_INPUTS.json`。

## 最终联合前置门

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_*.py --junitxml=artifacts/autonomous-brain/recovery-closure-20260926/raw/gate/python-full.xml
node --test tools/tests/test_autonomous_brain_*.js
node --test workspaces/guangyang-platform/projects/car-python/tests/robot-bridge.test.js
```

结果分别为 **1323、29、15 passed，0 failed，0 skipped**。日志为 `raw/gate/python-full.txt`、`node-full.txt`、`frozen-platform-boundary-authorized.txt`。`TESTS.json` 从同一次 JUnit 输出按文件复算；7 个新测试文件的 **114** 项是 1323 项的子集，不能相加。

冻结平台首次受限环境运行有 2 项本机回环监听 EPERM；未修改测试或代码，在允许监听的环境重试后 15 项全部通过。前者是环境失败，保留 `raw/gate/frozen-platform-boundary.txt`，不是代码通过证据。

## 开发正反对照

| 范围 | 首次反例 | 最终相关检查 | 原始日志/命令 |
| --- | --- | --- | --- |
| 普通发现、resolver、任务完成 | 7 failed | 新定向 24 passed；相关 362 passed | `raw/discovery/first-red.txt`、`directed-final.txt`、`related-final.txt`；完整命令在 `implementation-summary.json` |
| 真实归路、历史路口引用恢复 | 2 failed / 1 passed | 相关 219 passed | `raw/navigation/first-counterexamples.txt`、`final-development-regression.txt`；命令见下文 |
| 真实平台短段契约 | 7 failed / 1 passed；交叉审阅再发现 3 failed / 9 passed | 相关 55 passed | `raw/route-contract/initial-red.txt`、`cross-short-red.txt`、`cross-short-fixed.txt` |
| 延迟抓持生产者→独立审计 | 1 failed / 1 passed | 新定向 17 passed；消费端相关 267 passed | `raw/evaluation/p5-red-confirmed.txt`、`consumer-directed-final.json` |
| 合成模型地址及真实日志消费者 | 14 failed / 1 passed | 相关 Python 429 passed、Node 配置 7 passed；最终新增文件 15 项均通过 | `raw/model-config/initial-red.txt`、`related-python.txt`、`node-config.txt`；最终日志见联合门 |

开发集合互相重叠，也包含修复迭代期间的不同源码快照，不用数量差异表示能力提升。P5 最早两次夹具调试输出和道路 0.5° 非法夹具探针也原样保留，并在各子目录说明；它们不冒充有效产品反例。最终归路和换位运动桩实际使用冻结平台参数校验。

道路 219 项的实际命令：

```sh
python3 -m pytest -q tests/test_brain_recovery_map_closure.py tests/test_brain_recovery_topology_audit.py tests/test_brain_topology_evaluation.py tests/test_brain_route_contract.py tests/test_brain_semantic_road_evidence.py tests/test_brain_stage2_adversarial.py tests/test_brain_navigation.py tests/test_brain_reverse_completion.py tests/test_brain_road_node_locator.py tests/test_brain_observed_routes.py tests/test_brain_navigation_reposition.py tests/test_brain_route_evidence.py tests/test_brain_place_path_recovery.py tests/test_brain_pick_road_return.py
```

短段 55 项的实际命令：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_route_contract.py tests/test_brain_route_evidence.py tests/test_brain_navigation_reposition.py tests/test_brain_road_clearance.py tests/test_brain_visual_standoff.py
```

## 分层诊断

`OLD` 指隔离恢复的原阶段 1 `map-05-run-1` 目录；其输入 SHA 见各输出，不修改原件。

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/replay_brain_llm.py --input "$OLD" --out <new-replay-directory>
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/audit_delivered_identity_prefix.py --brain-dir "$OLD/brain" --output <new-prefix-json>
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/diagnose_road_reposition.py --output <new-road-json>
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/verify_brain_revision_inputs.py --restore <new-isolated-stage1-root> --out <new-integrity-json>
```

- 模型离线回放：111/111 轮、115/115 调用逐字节语义一致；网络和环境读取均为 0。使用原 prompt 和原参数，不执行动作。
- 新 Perception 的固定传感前缀诊断：594 帧，旧 obs 591/r110 的第二次 place 见证仍被拒绝，保留分叉。原 frame 590 错误关联不能靠后继旧动作强行恢复；这不是新闭环 PASS，也不改历史 PASS。
- 合成曲路：候选到达及新视觉判据通过；实测里程 42.2cm、逐步端点位移和 40.702281cm、净位移 36.055513cm 分别保留，不互相替代。
- 历史原件及隔离恢复清单：阶段 1 各 79 项、上轮各 95 项；平台 58 文件、WorldModel 50 文件不变。

上列 `verify_brain_revision_inputs.py` 记录原工作机器的实际完整性门：它依赖平台原嵌套 Git checkout，并同时核验源码根历史原件和 `--restore` 隔离副本。Release 平台子包不含 `.git`；外部新目录按 `RESTORE.md` 的逐文件 SHA 命令复核内容，不能将解压文件的父仓库 HEAD 当作平台 revision。其余只读评测、模型回放和参数测试不需要重建平台 Git 元数据。

正式运行命令、独立复算输入范围和验收结果见 `REPORT.md`。以上离线层次不替代正式自主闭环验收。
