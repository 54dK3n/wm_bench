# 本地导出压力诊断02：导出 PASS，任务验收不适用

本次使用本地 `export-diagnostic-stub` 固定应答服务，没有调用真实模型或外部模型API。50次扫描产生500条真实公开传感观测，仿真232.00秒。它验证大规模证据导出和归档，不是自主模型任务试验，不计入真实模型运行索引或任务成功次数。

driver 为 `wm-autonomous-brain-driver/v5`，导出结束 `status=complete`、`sourcesUnchanged=true`；`export-status.json` 为 `complete=true`、`failures=[]`。brain 以预期的 `round_limit` 结束，50轮上限已达到，driver 返回码1、任务 `success=false` 保留。**导出诊断 PASS 与任务 FAIL 是不同结论**，不把本次诊断当作双球验收通过。

`diagnostic-checks.json` 的检查全部通过：50个本地固定应答请求、500观测、完整导出，以及 record、samples、sensor-audit、captures 四份 gzip 的压缩/展开长度及SHA256匹配。本次归档再次流式检查了四份 gzip 的完整性与元数据，并保持所有原始文件逐字节不变。详见 `archive-checks.json`。

## 大文件的无损归档

原始 `map-05-run-1/record.json.gz` 为 **115,695,381字节**，超过100MiB。原件继续留在本地；`.gitignore` 仅忽略这一个精确路径，不忽略同目录的其余证据。

原始gzip SHA256：

```text
7d05a534380ccefe1ae4b6f59aaa91ebbac519df40ebfc2662a19591cf38462e
```

展开内容为 **164,490,084字节**，SHA256：

```text
0d44ff3c8191f5c7c777890bc5d29ebf1c7e8091e5476cf7ca3ab966780a4200
```

`record.chunks/` 包含原始压缩字节的连续分片，大小依次为52,428,800、52,428,800、10,837,781字节；打包过程没有解压、重新压缩或修改原件。`manifest.json` 保存原始相对路径、总长度、全文件SHA256，以及每片索引、偏移、长度和SHA256。四份 gzip 的展开哈希验证是另外的只读检查。

在仓库根目录恢复到原始路径：

```sh
python3 tools/evidence_chunks.py restore artifacts/autonomous-brain/export-stress-20260925-02/record.chunks/manifest.json
```

工具逐片验证后恢复原始gzip；原件存在且完全相同则接受，存在不同内容则拒绝覆盖。只需版本化整个 `record.chunks/` 及其余小文件，无需把超过100MiB的原gzip加入Git。

本次已把分片复制到仓库外的临时目录，恢复为新文件，并逐字节比较原件、校验总长度与SHA256；随后清理临时目录，未留下待提交的重复gzip。分片说明见 `record.chunks/README.md`。

本次没有重跑模型、动作或仿真，没有修改500条观测及原始证据、运行源码、Run11或真实运行索引，也没有提交或推送。
