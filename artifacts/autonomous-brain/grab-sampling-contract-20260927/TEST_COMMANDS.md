# 命令、范围与复算

以下最终局部门在冻结候选相同源码字节上执行。Git报告只存计数/哈希，完整输出在Release包的raw。开发中重叠测试不相加；`python-integration-1`为中途1690通过/7失败，失败分别是旧夹具缺round的2项、版本断言2项、本机监听限制3项。修正夹具/版本后，允许测试夹具监听本机完成最终门；没有更改平台权限或禁用用例。

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_*.py --junitxml=artifacts/autonomous-brain/grab-sampling-contract-20260927/raw/gate/python-final.xml
node --test tools/tests/test_autonomous_brain_*.js
node --test workspaces/guangyang-platform/projects/car-python/tests/robot-bridge.test.js
```

最终分别1717、29、15通过，失败/错误/跳过均0。第三项及Python三个HTTP测试只监听本机，未请求实际模型。此前选定反例和各正反范围见GRAB_REVIEW、SAMPLING_REVIEW、PROGRESS_REVIEW、AUDIT_REVIEW。

最终合成导出与摘要命令如下；原输出只创建一次，复核时改为新路径。`--repo`指定实际所选代码；导出保存源哈希，抓取入口另核对实际import与AST，采样入口从当前测试文件所在repo加载。它们不请求模型或运行平台仿真。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/export_grab_examples.py --repo . --output artifacts/autonomous-brain/grab-sampling-contract-20260927/raw/gate/grab-frozen-candidate.json
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:vendor/wm_kit_opt2 python3 tests/test_brain_sampling_inverse_chain.py --output artifacts/autonomous-brain/grab-sampling-contract-20260927/raw/gate/sampling-frozen-candidate.json
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/executable-recovery-20260927/raw/formal-stage1/map-05-run-1 --out artifacts/autonomous-brain/grab-sampling-contract-20260927/raw/gate/historical-v19-replay
python3 artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/summarize_gate.py --repo . --evidence artifacts/autonomous-brain/grab-sampling-contract-20260927 --output artifacts/autonomous-brain/grab-sampling-contract-20260927/GATE.json
python3 artifacts/autonomous-brain/grab-sampling-contract-20260927/scripts/summarize_metrics.py --repo . --evidence artifacts/autonomous-brain/grab-sampling-contract-20260927 --output artifacts/autonomous-brain/grab-sampling-contract-20260927/METRICS.json
```

源代码4fa8916已包含测试与预检工具；报告脚本在本轮证据包中。分离恢复代码和证据时使用RESTORE.md的路径示例。历史输入只读，严格回放97轮/97调用、网络0；旧r34审计与当前合成独立消费者复算命令见AUDIT_REVIEW.md。

唯一真实服务预检已执行以下命令，退出1、HTTP402、请求1次。这里只记录事实，**复核交付不应再执行它**：

```sh
PYTHONDONTWRITEBYTECODE=1 node tools/brain_model_preflight.js --out artifacts/autonomous-brain/grab-sampling-contract-20260927/raw/preflight/live-once
```

stdout/stderr和完整转录单独保存。客户端不输出凭据，不重试transport或无效JSON修复；未启动机器人。预检失败后没有执行任何新正式driver命令，也没有运行阶段2/十布局/真机。
