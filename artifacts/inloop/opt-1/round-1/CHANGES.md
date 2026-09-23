# opt-1 round-1 改动

PROGRAM_VERSION: wm-opt1-r1-20260923。

- 修复局部道路停止边界和重复frontier，数值依据及单测见 ../planner_change.md。
- 接入独立confidence-floor-dev-v1，红保留≥0.84、蓝保留≥0.80；完整原始observe日志在过滤前输出，逐检测过滤理由另列。常数的三个独立场景依据见 ../filter-candidate-v1/DEVELOPMENT.md、constant_provenance.json。
- 清理目标道路锚点死读取；M5、确认和WM融合AST、嵌入ZIP均保持一致。
- 真正平台异步转换后的过滤桥接执行测试通过，返回原始对象身份未改变；175项检查通过，指定pylint零错误。
- 首次冻结测试过滤门失败；在本轮完整十局结束前不修改程序。测试结果见 ../filter-test-v1/test_evaluation.json。后续如改规则须声明污染。

所有哈希由本轮identity/code_manifest文件给出，所有实际失败仍计入。
