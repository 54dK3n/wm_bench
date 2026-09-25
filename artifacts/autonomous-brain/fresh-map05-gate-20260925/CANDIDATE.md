# map-05 新实跑门禁候选报告

状态：等待脑源码冻结通知；尚未启动 transport-smoke-03，因此本报告不是最终通过结论。

已准备独立离线复核工具 `tools/fresh_map05_platform_gate.js`。最终输入为 `artifacts/autonomous-brain/transport-smoke-02` 和 `artifacts/autonomous-brain/transport-smoke-03`，两次均使用真实平台、外部 Python 脑和真实机器人桥；模型为本机固定响应诊断替身，不代表真实大模型验收。

第一局（smoke02）原始证据复核结果已写入 `preparation.json`：10 次 observe，桥内容逐条匹配独立原始检测转换；红球 1、蓝球 3、障碍 34、存放区 2。第二局数字、两局应见检出以及检测一致性将在新局完成后写入独立 `gate.json` 与 `REPORT.md`。本候选文件保留不覆盖。

仅桥逐条一致和四类非空构成门槛。30–85cm、绝对方位≤30° 的应见检出，以及同一固定脚本两次检测一致性只报告。真值只由离线评测读取，不提供给脑。
