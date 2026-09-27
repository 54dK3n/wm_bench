# 测试及诊断复算入口

所有命令从仓库根目录执行。运行前恢复仓库所需平台运行文件与 `vendor/wm_kit_opt2`；原始证据另行恢复至本轮 `raw/`。本文只列入口，没有在编写文档时重跑测试、模型或仿真。`raw/` 不进入 Git，脚本与本说明进入 Git。

## 最终统计口径

最终数量、失败/错误/跳过数、源码和证据 SHA 从 [GATE.json](GATE.json) 读取，不在本文复制易过期总数：

```sh
python3 -m json.tool artifacts/autonomous-brain/executable-recovery-20260927/GATE.json
```

[TESTS.json](TESTS.json) 按 Python classname 列出最终分布。GATE 中 `python` 对应 `raw/gate/python-final.xml`；`node.driver` 与 `node.platform` 分别对应各自日志。最终门没有删除、跳过或 deselect 用例；不要将开发回归、合成场景数、组件检查数或历史回放轮数相加为一个测试总数。

## 完整离线门

本轮实际最终 Python 命令及日志位置：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_*.py --junitxml=artifacts/autonomous-brain/executable-recovery-20260927/raw/gate/python-final.xml
```

标准输出保存在 `raw/gate/python-final.txt`。原生 Node 驱动与平台契约测试入口：

```sh
node --test tools/tests/test_autonomous_brain_*.js
node --test workspaces/guangyang-platform/projects/car-python/tests/robot-bridge.test.js
```

对应 `raw/gate/node-driver.txt` 与 `raw/gate/node-platform-localhost.txt`。部分测试须本地回环监听权限，不需要外部模型。重跑时使用新的日志/JUnit 路径，不覆盖已归档证据。`scripts/summarize_gate.py` 只消费已有日志、核验源及证据并以 create-only 方式写 GATE/TESTS；已有产物时不应直接再次运行它。

## 定向控制回归

新核心控制文件为 `tests/test_brain_executable_recovery.py`。首次反例、区域提供器修正、负边界及阶段结果见 [REVIEW.md](REVIEW.md) 与 `raw/navigation/development-summary.json`。以下是实际 17 文件开发合集命令，对应 `raw/navigation/development-regression.txt`：230 通过，0 失败、0 跳过、0 deselect；它早于最终门，不能替代最终源码结果。

```sh
python3 -m pytest -q tests/test_brain_executable_recovery.py tests/test_brain_navigation_candidate_filter.py tests/test_brain_route_contract.py tests/test_brain_route_evidence.py tests/test_brain_navigation_reposition.py tests/test_brain_route_progress.py tests/test_brain_road_clearance.py tests/test_brain_visual_standoff.py tests/test_brain_recovery_map_closure.py tests/test_brain_recovery_topology_audit.py tests/test_brain_semantic_road_evidence.py tests/test_brain_stage2_adversarial.py tests/test_brain_navigation.py tests/test_brain_reverse_completion.py tests/test_brain_road_node_locator.py tests/test_brain_observed_routes.py tests/test_brain_confirmation_sampling.py
```

采样视点、跨轮进展及探索交还的独立审阅入口：

```sh
python3 -m pytest -q tests/test_brain_sampling_viewpoint_comparison.py tests/test_brain_confirmation_sampling.py tests/test_brain_sampling_progress.py tests/test_brain_explore_sampling_handoff.py
```

这条组合命令是便捷复算入口，不虚称某一已有日志正由此组合产生。实际采样阶段命令及输出见 `raw/sampling/README.md`、`raw/sampling/handoff.json`；进展开发的完整实际命令见 `raw/recovery/state-contract-manifest-v2.json`。该 v2 清单明确：含显式 `test_brain_llm_discovery_contract.py` 又含 `test_brain_llm*.py` 的开发命令会重叠收集，记录的 688 为执行次数；最终全量 glob 每文件只列一次。亚度逆转边界原始红/绿日志位于 `raw/sampling/restore-min-turn-red.txt` 与 `restore-min-turn-related-green.txt`。

## 无仿真、无模型的真实组件与合成场景导出

下列命令会执行固定公开传感输入的组件诊断，使用真实感知、WM、动作与冻结命令校验，不启动平台仿真或模型。先建立一个新的输出目录；文件采用 create-only，不能覆盖旧证据。示例使用 shell 创建独立临时目录：

```sh
diagnostic_output_dir=$(mktemp -d /tmp/wm-executable-recovery.XXXXXX)
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/diagnose_executable_recovery.py --repo . --output "$diagnostic_output_dir/component.json"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 artifacts/autonomous-brain/executable-recovery-20260927/scripts/probe_sampling_viewpoints.py --repo . --output "$diagnostic_output_dir/viewpoints.json"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/diagnose_confirmation_sampling.py --output "$diagnostic_output_dir/prior-scenarios.json"
```

本轮最终门对应的输出分别为：

- `raw/gate/component-frozen-candidate.json`：完整逆原语、道路节点区域连接、新感知与 standoff 组件链，十项独立检查。
- `raw/gate/viewpoint-frozen-candidate.json`：十个新视点/恢复正反场景。
- `raw/gate/prior-scenarios-frozen-candidate.json`：十六个既有采样场景重新导出。

名称中的 `frozen-candidate` 只是所测候选源码导出名称，不独立构成 Git 冻结或正式验收证明。组件脚本支持 `--expect-fingerprints <旧组件JSON>`，在执行前精确核对该产物的 `source_before` 文件及所选 AST 指纹。`--repo` 选择实际导入仓库，并将源文件/AST 前后指纹写进输出。这些本地指纹不是未收到的外部探针指纹。

## 严格历史契约回放

本轮实际回放命令如下，原始输入须先恢复。输出已经存在，不要再次覆盖；复算时换新目录。

```sh
python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/active-confirmation-20260926/raw/formal-stage1/map-05-run-1/brain --out artifacts/autonomous-brain/executable-recovery-20260927/raw/recovery/historical-v18-replay
```

对应 `replay-checks.json`：200 轮、206 调用，0 网络、0 环境访问。它核验旧 v18 输入/输出契约，不重新调用模型，不重做历史运动，不计作本轮正式局。

## 原生平台有界局部诊断（与上述离线项分开）

此入口会启动本地平台仿真和公开桥接动作，不调用模型、不读取评测真值、没有任务答案脚本。它不是纯函数测试或历史回放；只在明确需要复核原生局部执行时单独运行。平台/浏览器依赖先恢复，输出目录必须尚不存在：

```sh
PYTHONDONTWRITEBYTECODE=1 node tools/diagnose_executable_platform.js --out /tmp/wm-native-recovery-new
```

示例路径若已存在须换一个新路径。内部限定最多 30 个运动原语、120 秒；依据当前公开道路净空选择安全斜向基础段，记录后经公开候选接口执行逆原语，保存观测、桥调用、运动和源哈希。既有最终证据在 `raw/platform-local-final/platform-diagnostic.json` 与 `local-controller-diagnostic.json`，所测源码、实际动作数和时间由 GATE 引用。

本轮原生诊断验证的是公开安全空间下的局部斜向归位；不会强迫固定 20 cm，也未复现完整合成组件的道路/感知确认链。其有界扫描后当前采样候选为零，因此没有原生采样确认成功。较早 `raw/platform-local-01/` 是开发快照，最终门只引用 `platform-local-final/`，两者不能混用。
