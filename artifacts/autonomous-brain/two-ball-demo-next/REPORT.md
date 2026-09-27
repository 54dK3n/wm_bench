# 双球开发基线 FAIL，已停止

真实 map-05 指令“把两个红球送到绿色存放区”运行一局后失败；`evaluate_autonomous_brain.py` **已实际执行并生成 FAIL**，driver/evaluator 均 exit 1。首次持球后的存放路线受净空阻塞，随后平台桥关闭；record、samples、sensor-audit、captures、envelope 全部导出失败。**物理两球身份、物理交付数和平台 run ID 无法独立核验，缺失不等于真值 0。** 原始脑端日志、错误及不完整导出状态保留，不声称已归档缺失的 record 或录像。

冻结主仓 [`d6c107f197a1845f8cc1ba66a413512f9a1c5b71`](https://github.com/54dK3n/wm_bench/commit/d6c107f197a1845f8cc1ba66a413512f9a1c5b71)，生产文件与 `c4bf08e1114363ddff3c0f5bce7cdcb1c041af27` 相同，运行前后源码一致。既有 `octos_robots.Executor` 为 `33af31baefc9b3beaa855f33849d52254aaa8c4b`，平台 `54b36f82109836226cf654e9a676ddf0c3b07cd0`，实际 vendored WM 源树 SHA256 `10895f70be67c9d70b1073256d7e264451934c8d025a11a82128bb7ad956cd7c`；不是外部 Octos runtime。真实链路仍为平台传感 → 同一 WM → DeepSeek Flash → Executor → Actions → 新观测。模型保持官方 `deepseek-flash` / 0 / disabled，原白名单、安全门和 200 轮/1200 秒预算不变。

| 公共日志可核验指标 | 本局 |
|---|---:|
| 真实 LLM started / finished / 完整调用 | 73 / 73 / 73 |
| 决策记录 / 无异常返回轮；Executor dispatch / judge | 73 / 72；73 / 72 |
| WM 观测 / 桥请求；高层 pick / 实际 grab / release | 349 / 1603；2 / 4 / 0 |
| 观测抓持成功 / 脑端 DELIVERED / 模型 done | 1 / 0 / 0 |
| 最后有效观测；当时仿真时间 / 夹爪 | obs349、tick17684；353.68 秒 / 持物 |
| 独立物理身份与交付；平台 run ID | 无法核验；不可取得 |

r37 的 `brain-000679` 由 obs150 授权，obs151 首次 holding=true，obs157 为 WM HELD；之后有效观测一直持物。r59 首次出现持球后的 `front_clearance` 阻塞，r62/65/70 的普通 go_to 再次进入该失败路段。r73 的 `brain-001602` turn 提交收到 HTTP 409 `BRIDGE_CLOSED`，恢复读取 `brain-001603` odometry 同样 409；没有新观测，保留 `outcome_unknown` 且未重发，不能声称该 turn 已实际执行。控制器关闭的具体原因未取得，不能推断账户、付款或模型服务原因；本局没有耗尽轮数或仿真秒预算。

既有采样 r32 实际移动 31cm、增加 2 个独立 hit，但 `target_017/027` 竞争未解除。r36 起该候选摘要出现 `manipulation_boundary_unresolved`，其发现引用跨过失败 grab 623/633，之后又跨 669/679；这只是已出现的摘要限制。**首球未交付，交付后第二球采样窗口 NOT_EXERCISED；新窗口逻辑未实施、未实测，不能列为本局已证实终因。** 详见包内 `raw/checks/second-target-sampling.json`。严格模型转录 73/73 PASS，仅证明转录一致，不替代缺失的平台物理验收。

已定位普通 go_to 重复失败路段，但仅拒绝旧段不能证明存在可行后继；桥关闭又缺少控制器导出证据。因此未做推测性小修、未开第二局，也未扩大规划框架或无修改重跑。[第一局一球 PASS](../octos-minimal-demo-next/REPORT.md) 与[第二局一球 PASS](../one-ball-review-next/REPORT.md) 保留，不据此推算成功率；阶段 2、十布局、真机未启动。

**实际入口**（来自 `raw/BASELINE_RUN.json`；下列目录已运行，不得覆盖。PYTHONPATH 将本机绝对路径等价写为仓库相对路径）：

```sh
node tools/autonomous_brain_driver.js --maps map-05 --runs 1 --platform-root workspaces/guangyang-platform/projects/car-python --orchestrator-root workspaces/octos_robots --task '把两个红球送到绿色存放区' --out artifacts/autonomous-brain/two-ball-demo-next/run-20260927T232942
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 python3 tools/evaluate_autonomous_brain.py --input artifacts/autonomous-brain/two-ball-demo-next/run-20260927T232942/map-05-run-1 --out artifacts/autonomous-brain/two-ball-demo-next/run-20260927T232942-evaluation
```

**恢复与复算：** [本轮 Release](https://github.com/54dK3n/wm_bench/releases/tag/two-ball-baseline-20260927-d6c107f) 使用 `wm-bench-two-ball-baseline-20260927-evidence.tar.gz`；原日志只在附件，Git 只保留摘要、SHA256 和入口。下载 `DELIVERY.json`、其 `archive` 指定的包及同名 `.sha256` 到新空目录，执行以下校验/提取；这里不预称上传或匿名下载校验已完成，最终以 publication 记录为准。

```sh
DEMO_ARCHIVE=$(python3 -c 'import json; print(json.load(open("DELIVERY.json"))["archive"])')
shasum -a 256 -c "$DEMO_ARCHIVE.sha256"
mkdir evidence && tar -xzf "$DEMO_ARCHIVE" -C evidence
(cd evidence && shasum -a 256 -c artifacts/autonomous-brain/two-ball-demo-next/SHA256SUMS)
```

包内 `raw/checks/public-run-counts.json` 给出每个原日志 SHA256、计数定义和命令引用；其中“待导出/待评测”是计数时状态，最终状态以 `raw/baseline.exits.json`、原 `summary.json`、`export-status.json` 和 `run-20260927T232942-evaluation/evaluation.json` 为准。以下只读计数不访问模型/平台，也不重新评分：

```sh
python3 - <<'PY'
import json
from pathlib import Path
p = Path('evidence/artifacts/autonomous-brain/two-ball-demo-next/run-20260927T232942/map-05-run-1/brain')
read = lambda name: [json.loads(line) for line in (p / (name + '.jsonl')).read_text().splitlines()]
r, b, l = read('rounds'), read('bridge-calls'), read('llm.lifecycle')
print({'live_started': sum(x['event']=='started' and x.get('mode')=='live' for x in l), 'rounds': len(r), 'observations': len(read('observations')), 'bridge': len(b), 'pick': sum(x['action']['action']=='pick' for x in r), 'grab': sum(x['request']['method']=='grab' for x in b), 'release': sum(x['request']['method']=='release' for x in b)})
PY
```

依赖逐文件哈希随 `manifest.json` 和 `raw/checks/config-and-dependencies.json` 保留。平台恢复使用[既有依赖指南](https://github.com/54dK3n/wm_bench/blob/3029e7184c267014fadb4eb55d562a9c501cdb4f/artifacts/autonomous-brain/grab-sampling-contract-20260927/RESTORE.md#冻结平台与-worldmodel)；本轮包不含平台依赖或缺失的物理原件。审阅源码应另建上述冻结提交的 checkout，不回退用户工作区，不以新仿真补写本局证据。
