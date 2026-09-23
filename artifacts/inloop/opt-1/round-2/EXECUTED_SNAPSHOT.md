# 实际执行代码原样归档

核验通过：10局原生完整记录的 `sourceCode` UTF-8 字节完全一致，均匹配 `identity.file_sha256` 和每局 `program_version` 日志。

- 版本：`wm-opt1-r2-20260924`
- [执行快照](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/executed_program.py)：`25590162d87b90c4dcb6c1d9766d7e62a115bfc07f68c709c8a61fb75fd78e34`，169,192 bytes。
- [校验文件](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/executed_program.sha256)
- 原冻结程序：`6cc3479d55051161f2c451226bda3a61a578c8fd9f84d020848c902c2c5d35cc`，169,193 bytes。
- wm_kit commit：`ad237a143f0d35e100a28c15567d4b75bd56cccf`
- 嵌入ZIP SHA256：`651a89967b41aad583b70e5f5095c5fc35f6babc950d8ab878748cb69e9f66e3`

快照直接取完整原生记录中的sourceCode，未trim、重排或补换行。原program.py只作比较；其首尾空白经平台trim后恰与sourceCode一致，所以原文件SHA和实际执行SHA不同。本归档不替换原文件、不修改manifest或原报告。

| 局 | 原生record | sourceCode bytes | 版本日志L | 完成事件E |
|---|---|---:|---:|---|
| [map-01](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-01.json) | [attempt-002.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-002.record.json) | 169192 | 0 | [4] |
| [map-02](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-02.json) | [attempt-009.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-009.record.json) | 169192 | 0 | [6] |
| [map-03](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-03.json) | [attempt-011.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-011.record.json) | 169192 | 0 | [6] |
| [map-04](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-04.json) | [attempt-005.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-005.record.json) | 169192 | 0 | [3] |
| [map-05](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-05.json) | [attempt-001.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-001.record.json) | 169192 | 0 | [5] |
| [map-06](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-06.json) | [attempt-010.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-010.record.json) | 169192 | 0 | [6] |
| [map-07](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-07.json) | [attempt-013.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-013.record.json) | 169192 | 0 | [1] |
| [map-08](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-08.json) | [attempt-015.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-015.record.json) | 169192 | 0 | [5] |
| [map-09](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-09.json) | [attempt-003.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-003.record.json) | 169192 | 0 | [5] |
| [map-10](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/map-10.json) | [attempt-029.record.json](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/attempts/attempt-029.record.json) | 169192 | 0 | [3] |

L/E均为零起始数组下标。[逐局JSON审计](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-1/round-2/executed_snapshot_audit.json)包含原生record导出SHA、runId、四项版本身份及逐字节核对；所有检查通过。

[只读导出工具](/Users/ken/Desktop/wm_bench/artifacts/inloop/export_executed_snapshot.py)仅写上述新增归档；若已有同名归档不同会拒绝覆盖，可按JSON中的reproduce命令复跑。此存证只证明实际执行源码身份，不新增任何任务性能结论。
