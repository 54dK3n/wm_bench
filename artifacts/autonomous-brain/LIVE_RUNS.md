# 真实模型运行记录

截至前五局，map-05 尚未成功，十布局未开始。配置成功、单元测试和模型离线回放不替代双球任务验收。以下均为真实 Kimi 请求；原始日志和失败结论保留。

| 运行 | 轮数 / 模型调用 | 模型耗时（秒） | 仿真用时（秒） | 结论与原因 |
|---|---:|---:|---:|---|
| [首局](map05-run-01/FAILURE_ANALYSIS.md) | 40 / 40 | 447.027970 | 100.88 | FAIL；受阻后盲退导致离路，随后由评测侧请求停止并导出 |
| [第二局](map05-run-02/FAILURE_ANALYSIS.md) | 8 / 8 | 162.621409 | 17.44 | FAIL；第 8 轮模型请求超时 |
| [第三局](map05-run-03/FAILURE_ANALYSIS.md) | 2 / 2 | 112.149277 | 1.62 | FAIL；第 2 轮连接提前关闭 |
| [第四局](map05-run-04/FAILURE_ANALYSIS.md) | 1 / 1 | 75.585421 | 0.00 | FAIL；首请求 URLError，未生成动作 |
| [第五局](map05-run-05/FAILURE_ANALYSIS.md) | 42 / 47 | 919.209928 | 147.52 | FAIL；离线发现动作缺陷后正常中止，首球已确认但未抓取 |

五局均为 0 抓取、0 送达。每局的逐球时间线、位置误差口径和失败动作表见其 `report/REPORT.md`；没有已确认红球误差样本时保留空值，不报告零误差。

机器可读数据与源文件 SHA256 见 `live-runs.json`。各局完整状态、模型输入输出、动作与结果位于 `map-05-run-1/brain/`，原生 record、samples、传感器审计及评测相机真值压缩包保存在相邻目录。真值只供评测。

修复记录：[导航恢复](navigation-fix-20260925/REPORT.md)、[请求等待时间](llm-timeout-fix-20260925/REPORT.md)、[扫描后确认候选](scan-followup-fix-20260925/REPORT.md)、[流式传输](llm-streaming-fix-20260925/REPORT.md)、[瞬态重试](llm-retry-fix-20260925/REPORT.md)、[导航与放置证据](action-safety-fix-20260925/REPORT.md)。后续新局使用新目录；只有 map-05 正式成功后才运行十布局。
