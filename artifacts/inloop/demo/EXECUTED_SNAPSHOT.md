# 实际执行代码原样归档

核验通过：1局原生完整记录的 `sourceCode` UTF-8 字节完全一致，均匹配 `identity.file_sha256` 和每局 `program_version` 日志。

- 版本：`wm-demo-v1-20260923`
- [执行快照](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/executed_program.py)：`ee01a6161f0600422ec5bfdfaa7e8d7e832ff5a1802d4d247bbf6de7ab1947e6`，171,258 bytes。
- [校验文件](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/executed_program.sha256)
- 原冻结程序：`58a24a2d4fb9bd6b564530eb74ef627a71c2084e731a815cf21f5cc9bb7c7928`，171,259 bytes。
- wm_kit commit：`ad237a143f0d35e100a28c15567d4b75bd56cccf`
- 嵌入ZIP SHA256：`651a89967b41aad583b70e5f5095c5fc35f6babc950d8ab878748cb69e9f66e3`

快照直接取完整原生记录中的sourceCode，未trim、重排或补换行。原program.py只作比较；其首尾空白经平台trim后恰与sourceCode一致，所以原文件SHA和实际执行SHA不同。本归档不替换原文件、不修改manifest或原报告。

| 局 | 原生record | sourceCode bytes | 版本日志L | 完成事件E |
|---|---|---:|---:|---|
| [map-05](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/map-05.json) | [attempt-030.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/attempts/attempt-030.record.json) | 171258 | 0 | [8] |

L/E均为零起始数组下标。[逐局JSON审计](/Users/ken/Desktop/wm_bench/artifacts/inloop/demo/executed_snapshot_audit.json)包含原生record导出SHA、runId、四项版本身份及逐字节核对；所有检查通过。

[只读导出工具](/Users/ken/Desktop/wm_bench/artifacts/inloop/export_executed_snapshot.py)仅写上述新增归档；若已有同名归档不同会拒绝覆盖，可按JSON中的reproduce命令复跑。此存证只证明实际执行源码身份，不新增任何任务性能结论。
