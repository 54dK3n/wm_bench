# 本次门禁证据范围

两次真实平台诊断使用相同平台源码、同一诊断假模型脚本（explore、look_around、两次非法 JSON）。两次脑源码并不完全相同；以下文件在 smoke02 与 smoke03 之间修复，原始 SHA256 均在 gate.json 的 runs[].brainSource 中：

- `autonomous_brain/actions.py`
- `autonomous_brain/llm.py`
- `autonomous_brain/perception.py`

因此，两次检测一致性只是这两段实际传感器序列的报告，不声称已完成“同一整套脑程序的确定性验收”。平台内容一致性逐帧由独立 raw canonicalizer 验证，判定不依赖脑源码相同。

短路线内，三类物体落入指定 30–85cm、绝对方位≤30° 的真值应见次数均为 0；本报告没有由此推导召回率或探测能力。先前较长路线的应见统计仍保留在旧日志与报告中。

这些诊断没有执行 go_to、pick、place，不能证明实际抓取、放置、任务成功或真实模型决策成功。后续脑修改应分别按其真实测试范围报告。
