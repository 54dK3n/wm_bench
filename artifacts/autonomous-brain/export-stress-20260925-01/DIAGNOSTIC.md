# 首次导出压力诊断未达到规模

本次使用本机假模型，未调用真实模型。结果 FAIL：假模型返回旧的非流式 JSON，而当前客户端要求 SSE 完整结束标记；三次请求均为 IncompleteStream，第一轮未执行动作。仅产生1次观测，不能作为500帧压力验证。

本次仍完整导出 record、samples、sensor-audit、captures 和 envelope，四个gzip压缩前后SHA均匹配。数值见 `diagnostic-checks.json`；它保留 `passed:false`。诊断脚本 v2 已补 SSE 数据、结束事件与 [DONE]，复验使用新目录 `artifacts/autonomous-brain/export-stress-20260925-02`，不改写本次结果。
