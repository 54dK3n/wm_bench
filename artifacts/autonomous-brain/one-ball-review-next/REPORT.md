# 一球真实回归 PASS；双球阶段 1 NOT_RUN

本轮完成两处小修后，仅运行一次 map-05 指令“把一个红球送到绿色存放区”。真实模型经既有 Executor 决策，r37 HELD、r66 DELIVERED、r67 主动 done；独立一球评测 **PASS**，夹爪为空，运行期间源码未变。原 driver 的固定双球判据仍为 `false`（exit 1），一球 evaluator 为 exit 0；未交付另一球导致原双球两项失败，原字段保留，不能把一球通过写成双球通过。后续阶段、十布局和真机未运行。

冻结主仓 [`c4bf08e1114363ddff3c0f5bce7cdcb1c041af27`](https://github.com/54dK3n/wm_bench/commit/c4bf08e1114363ddff3c0f5bce7cdcb1c041af27)，编排 [`33af31baefc9b3beaa855f33849d52254aaa8c4b`](https://github.com/54dK3n/octos_robots/commit/33af31baefc9b3beaa855f33849d52254aaa8c4b)。链路仍是 `平台传感 → Perception / 同一 WM → octos_robots.Executor.run_next → LLMClient → Executor 分发 → Actions → 真实桥动作 → 新观测 / WM judge`；没有外部 Octos runtime 或假技能。模型为官方 `deepseek-flash` / temperature=0 / thinking=disabled，Executor `max_retries=0`，白名单、原确认/抓放门及 200 轮/1200 秒预算不变。

| 本局原日志复算 | 结果 |
|---|---:|
| 真实 LLM started / finished / 完整调用；完整轮 | 67 / 67 / 67；67 |
| Executor dispatch / judge；WM / 桥 observe | 67 / 67；311 / 311 |
| 高层 pick 决策；实际 grab / release | 2；4 / 1 |
| 桥总调用 / 运动请求；仿真秒 | 1422 / 172；268.82 |
| 物理有效交付 / 脑端 DELIVERED / 独立观测命令链 | 1 / 1 / 1 |
| 模型 done / 后置完成校验 / 夹爪；白名单外调用 | 1 / PASS / 空；0 |

**两修及验证范围：** `Perception.discovery_summary` 保留已 CONFIRMED 但仍需身份消解的候选，指定对象在截断前筛选，`Actions.identity_recovery_choices` 按指定目标查询并用原规划器核对可执行性；`Actions.pick/remember_action_result` 在失败当帧深复制竞争上下文及历史 hit 引用，恢复终点另存，`navigation_progress.grasp_identity_change` 对缺失原竞争保守拒绝。生产改动仅三文件，版本 Actions v27 / Perception v16，无阈值改变。原函数反例分别 6 FAIL / 1 PASS、3 FAIL / 2 PASS；最终相关回归 **93 PASS / 0 FAIL**，重叠测试不累计。旧 v14 断言漂移已显式同步 v16，首次 91 PASS / 1 FAIL 原输出保留；命令和范围见包内 `raw/checks/TEST_RESULTS.json`。

**真实分支边界：** r32 模型选择身份采样，实际前进 31cm、增加 2 个独立 hit，但 `target_017/027` 竞争未解除：`ATTEMPTED_NOT_RESOLVED`；不能仅由摘要证明 `has_pending_discovery=false` 的确切分支。新 pick 失败竞争上下文锁 `NOT_EXERCISED`：r35 是失去唯一可见性，竞争发生在 r31 的 go_to。pick 离路逆归路也 `NOT_EXERCISED`，r35/r37 均在路上，归路 0 运动。r36 路上转向及后退重获，r37 成功 grab 引用 `brain-000679`；模型另选唯一目标 `target_038` 完成，未删除旧 LOST。详见 `raw/checks/recovery-exercise-review.json`，不把整局 PASS 当成上述未触发分支已验证。

[上一成功基线 2adc8ae](../octos-minimal-demo-next/REPORT.md) 使用其冻结源码独立复算仍 PASS：原 53 文件 SHA、93,231,658 字节证据包 SHA 均匹配且复算后未变，指标逐字节相同；旧 driver false 保留。本局全局/前缀 Judge 各 3 match、严格转录 67/67 PASS；**转录一致不等于全部导航动作的物理验收**。实际 vendored WM 源树哈希与上一成功基线一致，`fef0ba9` 只是历史上游来源；依赖完整 SHA 见 [RESTORE.md](RESTORE.md)。

实际启动与评测命令来自包内 `raw/RUN.json`（已有目录不得覆盖；本轮已停止）：

```sh
node tools/autonomous_brain_driver.js --maps map-05 --runs 1 \
  --platform-root workspaces/guangyang-platform/projects/car-python \
  --orchestrator-root workspaces/octos_robots --task '把一个红球送到绿色存放区' \
  --out artifacts/autonomous-brain/one-ball-review-next/raw/one-ball-regression-20260927T222206
PYTHONPATH=vendor/wm_kit_opt2:. PYTHONDONTWRITEBYTECODE=1 python3 tools/evaluate_one_ball_smoke.py \
  --input artifacts/autonomous-brain/one-ball-review-next/raw/one-ball-regression-20260927T222206/map-05-run-1 \
  --out artifacts/autonomous-brain/one-ball-review-next/raw/one-ball-regression-20260927T222206-evaluation
```

[指标与输入哈希](METRICS.json) · [恢复/校验/复算](RESTORE.md) · [Release、原始日志及 delivered-frame300.png](https://github.com/54dK3n/wm_bench/releases/tag/one-ball-review-20260927-c4bf08e)。三个关键帧均从本局原 record 提取，INDEX 绑定本局 run ID；相同姿态的像素哈希可与旧局相同，不是借用旧证据。已停止，不继续开发或启动下一局；所有历史结论保留。
