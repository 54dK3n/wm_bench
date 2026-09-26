# 测试与复算入口

从仓库根目录运行，Python 3.9.6 / Node 26.7.0。输出选新路径，不能覆盖原证据。`raw/` 从本轮 Release 恢复。全部数字取自对应原始输出，开发集合重叠，不能相加。

## 冻结前联合门

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 -m pytest -q tests/test_brain_*.py --junitxml=<new-output.xml>
node --test tools/tests/test_autonomous_brain_*.js
node --test workspaces/guangyang-platform/projects/car-python/tests/robot-bridge.test.js
```

本次原输出 `raw/gate/python-full.{txt,xml}` 为 **1448 passed / 0 failed / 0 skipped**，61 个测试文件；`node-full.txt` 为 **29 passed**，`platform-boundary.txt` 为 **15 passed**。后两集合亦无失败或跳过。测试中的回环 HTTP 服务需要本机监听；没有模型请求或整车仿真。`GATE.json` 保存执行时 brain 字节哈希及日志哈希；`TESTS.json` 从同一 JUnit 按文件计数。

新文件子集：发现摘要 18、感知动作联动 19、探索语义 15、模型参数/回放/有限结果摘要 57、候选过滤 5，共 114 项，包含在 1448 中。短段正反例迁入既有 `test_brain_route_contract.py`。本轮短段、候选路线、探索语义和确认采样夹具中的运动使用实际平台 `normalizeCommand` 校验；不把这句话外推到全部历史测试桩。旧探索测试只升级其虚假“下一路口”结果断言，保留命令、运动预算、转角和恢复边界断言。

## 先红后绿

| 范围 | 首次输出 | 闭环依据 |
|---|---|---|
| 短段/候选过滤 | `raw/navigation/first-red.txt`：8 fail / 13 pass | 路径相关 187 pass，最终含探索合集281 pass |
| 探索新语义 | `raw/navigation/explore-first-red.txt`：7 fail | 实际 RoadMemory + normalize 新15项；旧语义11项红例升级断言后98相关pass |
| 主动感知采样 | `raw/sampling/first-red.txt`：10 fail / 1 pass | 最终19项全部通过，真实 Perception / WorldModel / Runtime / Actions |
| 后置遮挡/竞争 | `raw/sampling/extended-counterexamples.txt`：2 fail / 14 pass | 需要当前唯一可见证据，不能仅用历史CONFIRMED |
| 回退路径/未知运动 | `raw/sampling/reverse-and-exception-red.txt`：1 fail / 17 pass（失败项是未知回执未保存采样trace） | 精确横向距离及连续行驶证据，未知回执只记录、不重发 |
| 采样实际里程上限 | `raw/sampling/budget-red.txt`：1 fail / 18 pass | 实际里程超120cm即拒绝成功，不靠请求长度推定 |
| 新参数/旧记录语义 | `raw/contract/llm-discovery-red.txt`：20 fail / 34 pass | 当前v18，新意图；旧v1–v17原契约和修复文字保留 |

采样第一次实现为10 pass / 1 fail：原30cm两端的中点恰好15cm，没有规划所需2mm裕量；保留该拒绝例，并新增34cm真实已行驶路径的反向正例。此为夹具边界澄清，没有降低原15cm确认门。详细开发命令见各 `raw/*/*summary*` 与日志。

## 合成联动、历史文字回放、公开日志复算

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/diagnose_confirmation_sampling.py --output <new-synthetic.json>
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/wm_kit_opt2 python3 tools/replay_brain_llm.py --input artifacts/autonomous-brain/recovery-closure-20260926/raw/formal-stage1/map-05-run-1 --out <new-replay-directory>
python3 artifacts/autonomous-brain/active-confirmation-20260926/scripts/audit_previous_public_chain.py --brain-dir <restored-old-trial>/brain --output <new-chain.json>
python3 artifacts/autonomous-brain/active-confirmation-20260926/scripts/public_sampling_diagnostic.py --brain-dir <restored-old-trial>/brain --output <new-sampling.json>
```

合成脚本导出正常感知到运动再感知的完整公开输入、实际标准化运动、原始对象命中位姿与结果，不用返回“已确认”的 WorldModel 替身。其场景通过不等于整车任务通过。

历史候选1117336的v17文字回放200/200轮、203/203调用PASS，网络调用0；保持原prompt、状态和响应，不执行后继动作，不冒充新闭环。原文件及逐帧输入哈希在 `raw/contract/historical-v17-replay/replay-checks.json`。

原局公开链复算295红框→34条fed检测→15次有效hit（017四次，其余11个身份各一次）。首球交付后r79–200共122次explore；后期7个候选的17条fed记录，分别各1首个hit、0新增独立位姿。既不代表机器人全程未运动，也不代表7个或182个物理红球。
