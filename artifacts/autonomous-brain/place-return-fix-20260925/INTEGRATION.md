# 第八局后合并核验

第八局完全导出且 `sourcesUnchanged=true` 后才应用修复。本次版本：Actions v11、Perception v5、Runtime v4、LLM v9；评测器 v2。WorldModel、M5、模型参数、确认和抓放判据不变。

`integrated-tests.txt` 记录合并主包后的 **369 项检查通过**（exit 0）。完整命令和每个大脑源码 SHA256 在 `integrated-tests.json`，其中包括放置、身份绑定、近场无轨迹见证、下一状态证据、独立评测、历史回放与本地 HTTP 流式传输检查。没有真实模型或仿真成功声明。

Runtime v4 补上 `road_return` 的成功、原因、在路状态和观测编号。原始放置见证帧与归路后的帧分别保留。遗漏此字段的旧实现被新增用例复现；修复后状态证据 13 项检查通过，见 `runtime-return-before.json`、`runtime-return-after.json`。

独立影子副本的来源、适用范围和过程日志见 `REPORT.md`。释放身份补丁最初额外要求新轨迹；主包已纠正该问题：合法近场像素见证无需新轨迹，只有确有新轨迹时才绑定别名，见 `../delivery-identity-fix-20260925/near-field-witness/REPORT.md`。没有删掉其他 LOST 红球来制造完成。

下一正式局使用新目录 `artifacts/autonomous-brain/map05-run-09`。第八局 FAIL、所有旧局和旧评测报告保留。正式 map-05 通过后才运行十布局。
