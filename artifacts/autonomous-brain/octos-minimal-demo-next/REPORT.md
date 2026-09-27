# 真实一球搬运 PASS；双球阶段 1 NOT_RUN

map-05 指令“把一个红球送到绿色存放区”已由真实平台、真实 LLM 和同一 WorldModel 完成。仅运行本轮一局：r37 抓取并确认 HELD，r75 放置并确认 DELIVERED，r76 模型主动 done，夹爪为空；独立一球评测 **PASS**。原 driver 固定双球结果仍为 `false`，不改写成一球成功，也不把本局计为双球阶段 1。后续阶段、十布局和真机均未启动。

冻结主仓 [`2adc8aecc085c2f99f14131f1f2c10e7b109021e`](https://github.com/54dK3n/wm_bench/commit/2adc8aecc085c2f99f14131f1f2c10e7b109021e)；编排 [`33af31baefc9b3beaa855f33849d52254aaa8c4b`](https://github.com/54dK3n/octos_robots/commit/33af31baefc9b3beaa855f33849d52254aaa8c4b)，运行期间源码未变。实际复用 `octos_robots.orchestrator.executor.Executor.run_next → run_step → _dispatch`，不是外部 Octos runtime：

`平台 observe → Perception / 同一 WM → Executor.run_next → LLMClient（DeepSeek Flash）→ Executor 技能分发 → LiveOrchestration._execute → Actions.execute → 真实桥运动 → 新观测 / WM → LiveOrchestration._judge → 下一轮`

Executor `max_retries=0`；判定回调读取动作后 WM、夹爪和证据，不采信假技能报告。六动作、白名单与真值隔离、确认/抓放门和 200 轮/1200 秒上限保留。模型为官方 `deepseek-flash`，temperature=0、thinking=disabled。

| 由原日志复算的本局指标 | 结果 |
|---|---:|
| 真实模型 started / finished / 完整调用；完整决策轮 | 76 / 76 / 76；76 |
| Executor dispatch / judge；WM / 桥 observe | 76 / 76；361 / 361 |
| 桥总调用；运动请求；grab / release | 1654；204；4 / 1 |
| 物理有效交付 / 脑端 DELIVERED / 独立观测命令链 | 1 / 1 / 1 |
| 模型 done / 后置完成校验 / 最终夹爪 | 1 / PASS / 空 |
| 仿真时间；白名单外调用 | 299.7 秒；0 |

全局与前缀 Judge 各 3 match；严格转录回放 76/76 PASS，仅作为独立证据补充。数字、来源 SHA256、平台 run ID 和编排 run ID 见 [METRICS.json](METRICS.json)，计数入口见 [恢复说明](RESTORE.md)。原始独立判定为包内 `raw/smoke-01-evaluation/evaluation.json`。首次评测命令缺少 WM 导入路径，报 `ModuleNotFoundError`；错误日志保留，未产生评测结论。随后使用正确 `PYTHONPATH` 的完整评测才是本局 PASS 来源。

本轮修复了真实反馈暴露的接近前身份约束、失败采样反馈、抓取失效后的已测归路选择和有界停止反馈。实测边界：r35 两次 grab 均未抓住，随后目标不可见而拒绝第三次；归路只命中 `already_on_observed_road`，**未证明离路 pick 逆归路在本局成功执行**。r36 转向与后退重获视角，r37 成功抓取引用 `brain-000679`，不是失败的 `brain-000669`。原 `target_027` 身份竞争仍未解决，模型另选唯一可见 `target_038` 完成一球；未删除 LOST 来消除竞争。恢复后失败 context 可能丢失原竞争集合的静态风险本局未触发，保留为局限，不修改已冻结源码。详见包内 `raw/checks/first-grasp-review.json`；局部测试不是平台实测的替代。

本局实际执行命令如下（该目录已有冻结原件，不能重用；新运行示例及正确导入路径见 [RESTORE.md](RESTORE.md)）：

```sh
node tools/autonomous_brain_driver.js --maps map-05 --runs 1 \
  --platform-root workspaces/guangyang-platform/projects/car-python \
  --orchestrator-root workspaces/octos_robots \
  --task '把一个红球送到绿色存放区' \
  --out artifacts/autonomous-brain/octos-minimal-demo-next/raw/smoke-01
PYTHONPATH=vendor/wm_kit_opt2:. python3 tools/evaluate_one_ball_smoke.py \
  --input artifacts/autonomous-brain/octos-minimal-demo-next/raw/smoke-01/map-05-run-1 \
  --out artifacts/autonomous-brain/octos-minimal-demo-next/raw/smoke-01-evaluation
```

[本轮 Release 与原始关键帧 delivered-frame350.png](https://github.com/54dK3n/wm_bench/releases/tag/octos-one-ball-pass-20260927-2adc8ae) · [恢复/校验/复算](RESTORE.md)。原始日志与平台录像帧只在 Release 包；Git 保留摘要、脚本和哈希。[上一轮两局 FAIL](../octos-live-demo-20260927/REPORT.md) 及更早 PASS/FAIL 原样保留。本轮完成后停止，不自动启动双球或阶段 2。
