# Driver v5 实际导出验证

原第十一局 `RobotBackend.stop` 的 CDP 返回超时，六项评测导出缺失，结论保持失败。Driver v5 在评测页面保留导出对象，只返回小状态；JSON 以最多65536个UTF-16字符的块送出，在进程外逐块压缩并记录 SHA256。此改动未更改传感器白名单、平台代码或脑输入。

离线 Node 检查13项通过，原始输出见 `final-node-tests-v2.txt`。源码与测试SHA见 `manifest-after.json`。它们覆盖大字段/数组、Unicode边界、顺序及结束标记、同序号重取、部分失败保留和完成元数据写失败。

真实仿真验证均使用本机假模型，未调用 Kimi，不属于任务验收：

| 检查 | 结果 | 可复算证据 |
|---|---|---|
| 首次压力诊断 | FAIL；旧非流式假响应导致3次IncompleteStream，仅1帧 | `artifacts/autonomous-brain/export-stress-20260925-01/diagnostic-checks.json` |
| 修正流式诊断响应后压力复验 | PASS；50次完整扫描、500帧、232仿真秒 | `artifacts/autonomous-brain/export-stress-20260925-02/diagnostic-checks.json` |
| 压力复验record | 压缩115695381字节，展开164490084字节，分2510块输出 | 同局 `evidence.json` 与 `record.json.gz.export-progress.json` |
| 短流程联调 | PASS；14/14桥检测逐条一致，红1、蓝5、障碍49、存放区3 | `artifacts/autonomous-brain/export-smoke-20260925-01/diagnostic-checks.json` |

压力复验四项gzip压缩/展开SHA均通过，五项导出全部完成，运行中源码不变；短流程保留非法JSON一次修复仍失败即停止的结果。修正仅针对诊断桩SSE协议、明确假模型环境参数和新envelope压缩标识，未修改真实Kimi配置。

压力record超过GitHub单文件限制，以可恢复分片交付；原文件本地保留并单独忽略，恢复命令、分片SHA和完整复原核对见该诊断目录说明。第十一局遗失的数据并未恢复，也没有由这次诊断补写。

评测器 v3 只扩展对driver v5源码清单格式的识别，旧来源格式继续支持，真值/原生事件/终态与上限判据不变。大脑合并447项离线验证见 `artifacts/autonomous-brain/navigation-reverse-fix-20260925/INTEGRATION.md`。正式下一局使用 `artifacts/autonomous-brain/map05-run-12`。
