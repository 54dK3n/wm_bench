# 本轮复核入口

源码快照 `ba9edd36a773b896f9fe6e9eb37ed0f75e8e8a7c`；联合前置 FAIL，正式运行 0。先按 `RESTORE.md` 恢复本轮附件；需要历史原始输入时另恢复原 Release，不能覆盖原件。主结论见 `REPORT.md`，机器统计见 `METRICS.json`。

1. **停止原因**：`BOUNDARY_REVIEW.md` → `raw/boundary-review/invalid-endpoint-result.json`、`synthetic-run/rounds.jsonl`、`synthetic-run/summary.json`。将 `reproduce_invalid_endpoint.py` 复制到一个新的空目录，从冻结源码仓库根目录运行复制的脚本；它按自身目录 create-only 输出。仅合成 endpoint，真实日志消费者、0 网络，没有真实配置读取。
2. **R1/R3**：`tests/test_brain_review_r1_r3.py`、`tests/test_brain_scan_coverage.py`、`tests/test_brain_stage2_discovery.py`；`raw/motion-identity/implementation-summary.json`、`public-prefix-diagnostic.json` 与 `raw/stage2-discovery/implementation-summary.json`。固定前缀复算：`python3 tools/audit_delivered_identity_prefix.py --brain-dir <旧局brain目录> --output <新文件>`；新版工具另记录真实观测序号与持久发现账，结果源码哈希应与旧开发诊断区分。
3. **R2**：`R2_RELIABILITY.md` 给函数级反例、全部输入、命令与历史只读检查。`raw/evaluation/r2-history-readonly-complete/evaluation.json` 保留全局 Judge 和全动作前缀 Judge，不删除冲突帧。旧 witness 249/591 与新固定传感器诊断分列。
4. **R4/R5**：`NAVIGATION.md`、`tests/test_brain_route_evidence.py`、`tests/test_brain_route_progress.py`；最终 `raw/final-offline-gate/curved-reposition.json` 包含每步原语、实际运动、候选到达和新鲜视觉验证；`python3 tools/diagnose_road_reposition.py --output <新文件>` 可复算，不启动仿真。
5. **阶段 2**：先读运行前的 `TOPOLOGY_SCOPE.md` 与 `STAGE2_EVALUATION_DEFINITION.md`；`tests/test_brain_topology_evaluation.py` 中真实 RoadMemory→独立 evaluator 正对照，以及 `test_brain_stage2_adversarial.py`、`test_brain_unknown_discovery_evaluation.py` 拒绝性用例。最终完整测试 1193/28，通过项不等于阶段 2 正式验收。

旧 r102 / frame 590 的原始入口仍在原 Release `REVIEWER_ENTRYPOINTS.md`：r102 obs 502–523，reposition 508–522，候选来自 obs467，历史候选路径297.3cm，本次累计190.4cm、净28.65cm，完整候选换位成功0；停止方向-45.369645°对0°/-90.7°出口为**零个**严格<45°候选。完整成功定义须同时有实际道路到候选、重新观测和视觉接近通过。

旧 frame590=obs590=r110/tick28756，脑端误贴旧球 target_017，并引起全局评测身份歧义；原第二个成功 witness 为591。原释放边界248/590、成功witness249/591、obs592两个DELIVERED、done obs594保持原证据。原历史任务级PASS及全局2match/2unverifiable、动作前缀4match不改写。
