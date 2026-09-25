# 有向行程接线：独立诊断归档

**归档核验 PASS；正式任务仍为预期 FAIL。** 本次使用真实机器人桥和 `diagnostic-stub` 假模型，不使用 Kimi，不是任务验收。按设计执行 explore、look_around 两动作，第三轮非法 JSON 仅修复一次后以 LLMOutputError 停止；3 轮、4 calls、14 observations，仿真 6.26 秒。

- obs1→2 的真实 take_exit 结果 accepted=true，25 cm/81 ticks；obs2 的 road_traversal_events 正好记录一条 traversal-1。原 motions 中该 motion 只出现一次，行程内 motion 与它逐字段相同；两端 fresh atNode/onRoad、有出口、不同 observed node，帧/tick/里程对应。
- 下一轮 exploration_hints 为真实当前出口 90°、0.8°、−90°，最多三条，完整进入保存的 LLM request。它们是 current_fresh_unexplored；这个短诊断没有触发 recorded_directed_route 提示。后者的覆盖证据见独立 Run20 离线复算，不能由此 smoke 冒称验证。
- 14 个保存的公开 observation 均逐字段等于对应 bridge 返回，14 个均非空；检测类别次数 blue-ball 5、obstacle 49、red-ball 1、storage-zone 3。
- record、samples、sensorAudit、captures、envelope 五套导出均 complete，压缩/展开字节数与 SHA256 独立全等。原始文件 hash 全部不变，7 个 brain 源码 hash 与该局 manifest 相同。
- 原工具离线回放 3 轮/4 calls，全部消费，除 mode 外完整记录一致，联网入口被禁止且 0 次调用；子进程仅传入 PATH/PYTHONDONTWRITEBYTECODE，没有继承 API 配置。
- 全目录含 gzip 展开内容扫描：无 provider-key 模式、无非豁免敏感字段值、无绝对 home 路径、无存储或展开后超过 100 MiB 的文件。结构扫描只允许严格等于驱动固定常量 `<not recorded>` 的值，不对任意不匹配 provider 模式的 token 豁免。

首扫曾把 summary/progress/evaluation 三处 client_token 固定占位报告为敏感值，初次实际输出与规则修正依据保存在 [route-archive-initial-scan.json](route-archive-initial-scan.json)。检查驱动第 530 行固定常量后增加严格等值判定，未修改任何原件。

独立 21 项全部通过：[route-archive-checks.json](route-archive-checks.json)。可重跑的只读检查：[check_route_archive.py](check_route_archive.py)；命令及输出：[route-archive-command.json](route-archive-command.json)、[route-archive.stdout.txt](route-archive.stdout.txt)。

离线回放：[route-integration-replay/replay-checks.json](route-integration-replay/replay-checks.json)、[逐调用记录](route-integration-replay/replayed-llm.jsonl)、[命令](route-integration-replay-command.json)。原件 hash：[archive-original-sha256.json](archive-original-sha256.json)；最终文件清单：[archive-sha256.json](archive-sha256.json)。
