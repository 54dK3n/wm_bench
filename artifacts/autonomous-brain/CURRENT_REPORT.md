# 当前状态：运行中监控恢复已修复，本次双球受模型连接阻断

冻结 `e54ad6106123770880f407c82d2d3b9b2e75c5cd` 实跑一局，r1 的6次既有模型请求尝试均在连接建立阶段被重置（ConnectionResetError / errno54），有效回复0、分发0、grab/release/交付/done均0。驱动exit1；初次evaluator因空响应异常退出1，单独修复 `4cf908e4afe6134a9619dfa9a119fc0c5caa06f9` 后在新目录复算双球FAIL/exit1。五类原始物理导出完整，未改原件；网络重置根因UNKNOWN，没有无修改重跑。

运行中恢复最多一次/8秒、原运行和控制器身份核验、暂停新桥命令并只核对原在途请求；真实Chrome/子进程受控测试通过。本局未出现CDP故障，恢复和持球运输均NOT_EXERCISED，不能据测试宣称双球已通过。依赖、模型、预算及安全门保持；历史两次一球PASS和旧FAIL保留。已停止，下一阻塞为本机到官方模型服务的HTTPS连接被重置。

[本轮报告与复算](two-ball-monitor-next/REPORT.md) · [指标](two-ball-monitor-next/METRICS.json)。
